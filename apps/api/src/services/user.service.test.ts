import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { getOrCreateUser } from './user.service.js';

vi.mock('./admin.service.js', () => ({
  getDefaultNewUserIsAdmin: vi.fn().mockResolvedValue(true),
}));

function createMockFastify(existingUser = false): FastifyInstance {
  const mockLimit = vi
    .fn()
    .mockResolvedValue(
      existingUser ? [{ id: 'user-123', email: 'test@example.com', isAdmin: false }] : []
    );

  return {
    db: {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: mockLimit,
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    },
  } as unknown as FastifyInstance;
}

describe('user.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getOrCreateUser', () => {
    it('returns an existing user without creating a new one', async () => {
      const fastify = createMockFastify(true);
      const userInfo = { id: 'user-123', name: 'Test User', email: 'test@example.com' };

      const result = await getOrCreateUser(fastify, userInfo);

      expect(result).toEqual({ ...userInfo, is_admin: false });
      expect(fastify.db.insert).not.toHaveBeenCalled();
    });

    it('creates only a users row for a new user', async () => {
      const fastify = createMockFastify(false);
      const userInfo = { id: 'new-user-456', name: 'New User', email: 'new@example.com' };

      const result = await getOrCreateUser(fastify, userInfo);

      expect(result).toEqual({ ...userInfo, is_admin: true });
      expect(fastify.db.insert).toHaveBeenCalledOnce();
    });

    it('updates an existing user email when it changes', async () => {
      const fastify = createMockFastify(true);

      await getOrCreateUser(fastify, {
        id: 'user-123',
        name: 'Test User',
        email: 'changed@example.com',
      });

      expect(fastify.db.update).toHaveBeenCalledOnce();
    });
  });
});
