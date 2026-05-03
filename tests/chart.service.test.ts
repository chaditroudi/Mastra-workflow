import { describe, it, expect } from 'vitest';
import { chartService } from '../src/services/chart.service.js';

describe('chartService', () => {
  it('produces a valid Chart.js config', () => {
    const out = chartService.execute({
      chartType: 'bar',
      data: {
        labels: ['Q1', 'Q2', 'Q3', 'Q4'],
        datasets: [{ label: 'Sales', data: [100, 150, 175, 200] }],
      },
      title: '2025 Sales',
    });
    const cfg = out.chartConfig as { type: string; data: { labels: unknown[] }; options: unknown };
    expect(cfg.type).toBe('bar');
    expect(cfg.data.labels).toHaveLength(4);
    expect(cfg.options).toBeDefined();
  });

  it('applies a default palette when no colors are given', () => {
    const out = chartService.execute({
      chartType: 'pie',
      data: {
        labels: ['A', 'B', 'C'],
        datasets: [{ label: 'x', data: [1, 2, 3] }],
      },
    });
    const cfg = out.chartConfig as { data: { datasets: { backgroundColor: unknown }[] } };
    expect(cfg.data.datasets[0].backgroundColor).toBeDefined();
  });

  it('returns a QuickChart URL for small configs', () => {
    const out = chartService.execute({
      chartType: 'line',
      data: { labels: ['a', 'b'], datasets: [{ label: 'x', data: [1, 2] }] },
    });
    expect(out.imageUrl).toContain('quickchart.io');
  });

  it('omits imageUrl for large configs', () => {
    const big = Array.from({ length: 500 }, (_, i) => i);
    const out = chartService.execute({
      chartType: 'line',
      data: {
        labels: big.map(String),
        datasets: [{ label: 'huge', data: big }],
      },
    });
    expect(out.imageUrl).toBeUndefined();
  });
});
