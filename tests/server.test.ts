import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// Mock the orchestrator module BEFORE importing the app — vitest hoists vi.mock
// calls to the top of the file so this happens at module load.
vi.mock('../src/workflows/orchestrator.js', () => ({
  orchestrate: vi.fn(),
}));

// Mock the helpers used by /api/plan as well.
vi.mock('../src/workflows/orchestrator.helpers.js', () => ({
  planOnly: vi.fn(),
}));

// Now import the app — it will pick up the mocked modules.
const { createApp } = await import('../src/app.js');
const { orchestrate } = await import('../src/workflows/orchestrator.js');
const { planOnly } = await import('../src/workflows/orchestrator.helpers.js');

const app = createApp();

beforeEach(() => {
  vi.mocked(orchestrate).mockReset();
  vi.mocked(planOnly).mockReset();
});

describe('GET /health', () => {
  it('returns 200 with service info', async () => {
    const r = await request(app).get('/health');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.service).toBe('mastra-workflow');
  });
});

describe('auth — /api requires X-Tenant-Id', () => {
  it('rejects missing tenant header with 401', async () => {
    const r = await request(app).post('/api/orchestrate').send({ prompt: 'hi' });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('AUTH_REQUIRED');
  });

  it('accepts the request when header is present and prompt is valid', async () => {
    vi.mocked(orchestrate).mockResolvedValue({
      plan: { summary: 'ok', steps: [{ id: 1, agent: 'mongodb', action: 'create', args: {}, parallelizable: false, dependsOn: [] }] },
      results: [{ stepId: 1, agent: 'mongodb', action: 'create', ok: true, output: { insertedId: 'x' }, durationMs: 5 }],
      answer: 'done',
      charts: [],
    });
    const r = await request(app)
      .post('/api/orchestrate')
      .set('X-Tenant-Id', 'acme')
      .set('X-User-Id', 'alice')
      .set('X-Roles', 'admin')
      .send({ prompt: 'create a model' });
    expect(r.status).toBe(200);
    expect(r.body.answer).toBe('done');
    expect(orchestrate).toHaveBeenCalledOnce();
  });
});

describe('POST /api/orchestrate validation', () => {
  it('returns 400 when prompt is missing', async () => {
    const r = await request(app)
      .post('/api/orchestrate')
      .set('X-Tenant-Id', 'acme')
      .send({});
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when prompt is empty string', async () => {
    const r = await request(app)
      .post('/api/orchestrate')
      .set('X-Tenant-Id', 'acme')
      .send({ prompt: '   ' });
    expect(r.status).toBe(400);
  });

  it('accepts a pre-built plan instead of a prompt', async () => {
    vi.mocked(orchestrate).mockResolvedValue({
      plan: { summary: 'pre-built', steps: [{ id: 1, agent: 'chart', action: 'render', args: {}, parallelizable: false, dependsOn: [] }] },
      results: [],
      answer: '',
      charts: [],
    });
    const r = await request(app)
      .post('/api/orchestrate')
      .set('X-Tenant-Id', 'acme')
      .send({
        plan: {
          summary: 'pre-built',
          steps: [{ id: 1, agent: 'chart', action: 'render', args: {}, parallelizable: false, dependsOn: [] }],
        },
      });
    expect(r.status).toBe(200);
  });

  it('returns 400 on a malformed plan', async () => {
    const r = await request(app)
      .post('/api/orchestrate')
      .set('X-Tenant-Id', 'acme')
      .send({ plan: { summary: 'x', steps: [] } }); // empty steps fails PlanSchema
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });
});

describe('POST /api/plan', () => {
  it('returns the plan from planOnly', async () => {
    vi.mocked(planOnly).mockResolvedValue({
      summary: 'plan summary',
      steps: [{ id: 1, agent: 'mongodb', action: 'query', args: { collection: 'X' }, parallelizable: false, dependsOn: [] }],
    });
    const r = await request(app)
      .post('/api/plan')
      .set('X-Tenant-Id', 'acme')
      .send({ prompt: 'find all models' });
    expect(r.status).toBe(200);
    expect(r.body.plan.summary).toBe('plan summary');
  });

  it('rejects empty prompt', async () => {
    const r = await request(app)
      .post('/api/plan')
      .set('X-Tenant-Id', 'acme')
      .send({});
    expect(r.status).toBe(400);
  });
});

describe('error mapping', () => {
  it('maps an AppError thrown by orchestrate to its statusCode', async () => {
    const { AppError } = await import('../src/utils/errors.js');
    vi.mocked(orchestrate).mockRejectedValue(
      new AppError({ code: 'NOT_FOUND', message: 'no such record', statusCode: 404 }),
    );
    const r = await request(app)
      .post('/api/orchestrate')
      .set('X-Tenant-Id', 'acme')
      .send({ prompt: 'go' });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('NOT_FOUND');
  });

  it('maps an unexpected throw to 500', async () => {
    vi.mocked(orchestrate).mockRejectedValue(new Error('kaboom'));
    const r = await request(app)
      .post('/api/orchestrate')
      .set('X-Tenant-Id', 'acme')
      .send({ prompt: 'go' });
    expect(r.status).toBe(500);
    expect(r.body.error.code).toBe('INTERNAL');
  });
});

describe('request id propagation', () => {
  it('echoes a generated x-request-id header in the response', async () => {
    vi.mocked(orchestrate).mockResolvedValue({
      plan: { summary: '', steps: [{ id: 1, agent: 'mongodb', action: 'query', args: {}, parallelizable: false, dependsOn: [] }] },
      results: [],
      answer: '',
      charts: [],
    });
    const r = await request(app)
      .post('/api/orchestrate')
      .set('X-Tenant-Id', 'acme')
      .send({ prompt: 'go' });
    expect(r.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('echoes a caller-supplied x-request-id', async () => {
    vi.mocked(orchestrate).mockResolvedValue({
      plan: { summary: '', steps: [{ id: 1, agent: 'mongodb', action: 'query', args: {}, parallelizable: false, dependsOn: [] }] },
      results: [],
      answer: '',
      charts: [],
    });
    const r = await request(app)
      .post('/api/orchestrate')
      .set('X-Tenant-Id', 'acme')
      .set('X-Request-Id', 'fixed-123')
      .send({ prompt: 'go' });
    expect(r.headers['x-request-id']).toBe('fixed-123');
  });
});
