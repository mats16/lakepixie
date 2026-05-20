import type { FastifyInstance } from 'fastify';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SessionEventJobPayload } from '../types/event-queue.types.js';
import { insertSessionEventInTx } from '../db/helpers.js';

declare module 'fastify' {
  interface FastifyInstance {
    eventBatcher: EventBatcher;
  }
}

/** リトライ定数 */
const RETRY_INITIAL_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 30_000;
const RETRY_MAX_ATTEMPTS = 5;

/** タイムアウト定数 */
const WRITE_TIMEOUT_MS = 15_000;
const FLUSH_TIMEOUT_MS = 30_000;

/**
 * Promise をタイムアウト付きで実行する
 *
 * @param promise - 対象の Promise
 * @param ms - タイムアウト（ミリ秒）
 * @param label - タイムアウト時のエラーメッセージに含めるラベル
 * @returns Promise の結果
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  let timerId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timerId.unref();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timerId);
  });
}

/**
 * インメモリバッチバッファによるイベント永続化
 *
 * バッファにイベントを蓄積し、以下の条件で DB にフラッシュする:
 * - バッチサイズ到達（EVENT_PERSIST_BATCH_SIZE、デフォルト: 10）
 * - インターバル経過（EVENT_PERSIST_INTERVAL、デフォルト: 5.0 秒）
 *
 * 書き込み失敗時はエクスポネンシャルバックオフでリトライする。
 * add() 時に enqueuedAt を確定させ、リトライ時も元の時刻で DB に書き込む。
 *
 * フラッシュの直列化は Promise チェーン（flushChain）で実現。
 * boolean フラグと異なり、DB 操作がハングしてもタイムアウトでチェーンが進行する。
 */
export class EventBatcher {
  private buffer: SessionEventJobPayload[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  private shuttingDown = false;
  private retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private activeRetries = new Set<Promise<void>>();

  constructor(
    private readonly fastify: FastifyInstance,
    private readonly batchSize: number,
    private readonly intervalMs: number
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      this.flush().catch(err => {
        this.fastify.log.error({ err }, 'Periodic event flush failed');
      });
    }, this.intervalMs);
    this.timer.unref();
    this.fastify.log.info(
      { batchSize: this.batchSize, intervalMs: this.intervalMs },
      'EventBatcher started'
    );
  }

  add(payload: SessionEventJobPayload): void {
    this.buffer.push({ ...payload, enqueuedAt: new Date() });
    if (this.buffer.length >= this.batchSize) {
      this.flush().catch(err => {
        this.fastify.log.error({ err }, 'Batch-size event flush failed');
      });
    }
  }

  async flush(): Promise<void> {
    // アトミックにバッファを swap（並行呼び出しで空バッチを処理しない）
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];

    // Promise チェーンに繋げて直列化 + タイムアウト保護
    this.flushChain = this.flushChain
      .then(async () => {
        try {
          await withTimeout(this.doFlush(batch), FLUSH_TIMEOUT_MS, 'flush');
        } catch (err) {
          // doFlush は内部で Promise.allSettled を使い、失敗した各ユーザーのリトライを
          // 個別にスケジュールする。ここでの catch はタイムアウト時のみ到達する。
          // doFlush はバックグラウンドで継続実行中のため、重複リトライを避けるためログのみ出力。
          this.fastify.log.error(
            { err, eventCount: batch.length },
            'Flush timed out; doFlush will handle retries internally'
          );
        }
      })
      .catch((e: unknown) => {
        console.error('EventBatcher flush chain error (logger may be broken)', e);
      });

    await this.flushChain;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    for (const timer of this.retryTimers) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();

    // 実行中のリトライの完了を待機
    if (this.activeRetries.size > 0) {
      await Promise.allSettled([...this.activeRetries]);
    }

    // 実行中のフラッシュを待機（タイムアウト付き）
    try {
      await withTimeout(this.flushChain, FLUSH_TIMEOUT_MS, 'shutdown flush wait');
    } catch {
      this.fastify.log.warn('Shutdown: flush chain timed out, proceeding with final flush');
    }

    // 残りのバッファをフラッシュ
    if (this.buffer.length > 0) {
      const batch = this.buffer;
      this.buffer = [];
      try {
        await withTimeout(this.doFlush(batch), FLUSH_TIMEOUT_MS, 'shutdown final flush');
      } catch (err) {
        this.fastify.log.error(
          { err, eventCount: batch.length },
          'Shutdown: final flush failed, events may be lost'
        );
      }
    }

    this.fastify.log.info('EventBatcher shut down');
  }

  private async doFlush(batch: SessionEventJobPayload[]): Promise<void> {
    const eventsByUser = this.groupByUser(batch);
    const userIds = [...eventsByUser.keys()];

    const results = await Promise.allSettled(
      userIds.map(async userId => {
        const events = eventsByUser.get(userId)!;
        await withTimeout(
          this.writeUserEvents(userId, events),
          WRITE_TIMEOUT_MS,
          `writeUserEvents(${userId})`
        );
      })
    );

    for (let i = 0; i < results.length; i++) {
      const userId = userIds[i];
      const events = eventsByUser.get(userId)!;
      if (results[i].status === 'rejected') {
        const error = (results[i] as PromiseRejectedResult).reason;
        this.fastify.log.warn(
          {
            err: error,
            userId,
            ...this.summarizeEvents(events),
          },
          'Event flush failed for user, scheduling retry'
        );
        this.scheduleRetry(userId, events, 1);
      } else {
        this.fastify.log.info(
          {
            userId,
            ...this.summarizeEvents(events),
          },
          'Event flush succeeded for user'
        );
      }
    }
  }

  private summarizeEvents(events: SessionEventJobPayload[]): {
    eventCount: number;
    sessionIds: string[];
    eventTypes: string[];
    firstEventUuid: string | undefined;
  } {
    return {
      eventCount: events.length,
      sessionIds: [...new Set(events.map(e => e.sessionId))],
      eventTypes: [...new Set(events.map(e => e.type))],
      firstEventUuid: events[0]?.eventUuid,
    };
  }

  private groupByUser(events: SessionEventJobPayload[]): Map<string, SessionEventJobPayload[]> {
    const eventsByUser = new Map<string, SessionEventJobPayload[]>();
    for (const event of events) {
      const group = eventsByUser.get(event.userId);
      if (group) {
        group.push(event);
      } else {
        eventsByUser.set(event.userId, [event]);
      }
    }
    return eventsByUser;
  }

  private async writeUserEvents(
    userId: string,
    events: SessionEventJobPayload[],
    idempotent = false
  ): Promise<void> {
    await this.fastify.withUserContext(userId, async tx => {
      for (const event of events) {
        await insertSessionEventInTx(
          tx,
          {
            uuid: event.eventUuid,
            sessionId: event.sessionId,
            type: event.type,
            subtype: event.subtype,
            message: event.message,
            createdAt: event.enqueuedAt,
          },
          idempotent ? { idempotent: true } : undefined
        );
      }
    });
  }

  private scheduleRetry(userId: string, events: SessionEventJobPayload[], attempt: number): void {
    if (this.shuttingDown) return;

    const baseDelay = Math.min(RETRY_INITIAL_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
    const delay = Math.floor(baseDelay * (0.5 + Math.random() * 0.5));

    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      const retryPromise = this.executeRetry(userId, events, attempt);
      this.activeRetries.add(retryPromise);
      retryPromise.finally(() => {
        this.activeRetries.delete(retryPromise);
      });
    }, delay);
    timer.unref();

    this.retryTimers.add(timer);
  }

  private async executeRetry(
    userId: string,
    events: SessionEventJobPayload[],
    attempt: number
  ): Promise<void> {
    try {
      await withTimeout(
        this.writeUserEvents(userId, events, true),
        WRITE_TIMEOUT_MS,
        `retry(${userId}, attempt=${attempt})`
      );
      this.fastify.log.info(
        { userId, eventCount: events.length, attempt },
        'Event retry succeeded'
      );
    } catch (err) {
      if (attempt < RETRY_MAX_ATTEMPTS && !this.shuttingDown) {
        this.fastify.log.warn(
          { err, userId, eventCount: events.length, attempt, nextAttempt: attempt + 1 },
          'Event retry failed, scheduling next attempt'
        );
        this.scheduleRetry(userId, events, attempt + 1);
      } else {
        // 最終リトライ失敗: 個別にフォールバック書き込み
        this.fastify.log.warn(
          { err, userId, eventCount: events.length, attempt },
          'Event batch retry exhausted, falling back to individual writes'
        );
        await this.writeEventsIndividually(userId, events);
      }
    }
  }

  /**
   * イベントを1件ずつ個別に書き込む（最終フォールバック）
   *
   * バッチ全体のリトライが上限に達した場合に使用する。
   * 1件の問題イベントがバッチ全体をドロップさせることを防ぐ。
   */
  private async writeEventsIndividually(
    userId: string,
    events: SessionEventJobPayload[]
  ): Promise<void> {
    let succeeded = 0;
    let failed = 0;

    for (const event of events) {
      try {
        await withTimeout(
          this.writeUserEvents(userId, [event], true),
          WRITE_TIMEOUT_MS,
          `individualWrite(${event.eventUuid})`
        );
        succeeded++;
      } catch (err) {
        failed++;
        this.fastify.log.error(
          {
            err,
            userId,
            eventUuid: event.eventUuid,
            eventUuidType: typeof event.eventUuid,
            sessionId: event.sessionId,
            eventType: event.type,
            messageSize: (() => {
              try {
                return JSON.stringify(event.message).length;
              } catch {
                return -1;
              }
            })(),
          },
          'Event permanently dropped'
        );
      }
    }

    this.fastify.log.info(
      { userId, succeeded, failed, total: events.length },
      'Individual event write fallback completed'
    );
  }
}

/**
 * EventBatcher を初期化し、Fastify インスタンスにデコレートする
 */
export async function startEventBatcher(fastify: FastifyInstance): Promise<void> {
  const batcher = new EventBatcher(
    fastify,
    fastify.config.EVENT_PERSIST_BATCH_SIZE,
    fastify.config.EVENT_PERSIST_INTERVAL * 1000
  );

  batcher.start();

  fastify.decorate('eventBatcher', batcher);

  fastify.addHook('onClose', async () => {
    fastify.log.info('Shutting down EventBatcher...');
    await batcher.shutdown();
  });
}

/**
 * セッションイベントをバッチバッファに追加する
 *
 * バッファに追加するだけの同期処理。
 * 実際の DB 永続化は EventBatcher がバッチサイズ到達 or インターバル経過時に行う。
 */
export function enqueueSessionEvent(
  fastify: FastifyInstance,
  params: {
    userId: string;
    /** セッションID（UUIDv7 形式） */
    sessionId: string;
    eventUuid: string;
    type: string;
    subtype: string | null;
    message: SDKMessage;
  }
): void {
  fastify.eventBatcher.add({
    userId: params.userId,
    sessionId: params.sessionId,
    eventUuid: params.eventUuid,
    type: params.type,
    subtype: params.subtype,
    message: params.message,
  });
}
