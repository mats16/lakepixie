import { describe, expect, it } from 'vitest';
import { __testing } from './context-manager-mcp.service.js';

describe('context-manager-mcp.service', () => {
  it('serializes MCP text responses as compact JSON', () => {
    const response = __testing.jsonContent({
      session_context: {
        cwd: '/workspace',
        outcomes: [{ type: 'databricks_apps', name: 'demo-app' }],
      },
    });

    expect(response.content[0].text).toBe(
      '{"session_context":{"cwd":"/workspace","outcomes":[{"type":"databricks_apps","name":"demo-app"}]}}'
    );
  });
});
