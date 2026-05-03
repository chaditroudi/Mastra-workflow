import type { ChartToolInput, ChartToolOutput } from '../schemas/agents.js';

/**
 * Chart service. Outputs a Chart.js-compatible config object that the front-end
 * can render directly, and optionally a QuickChart.io URL for a server-rendered
 * preview image (useful for emails, Slack previews, etc.).
 */
export const chartService = {
  execute(input: ChartToolInput): ChartToolOutput {
    const config = {
      type: input.chartType,
      data: {
        labels: input.data.labels,
        datasets: input.data.datasets.map((ds, i) => ({
          ...ds,
          backgroundColor: ds.backgroundColor ?? defaultPalette(i),
          borderColor: ds.borderColor ?? defaultBorder(i),
          borderWidth: ds.borderWidth ?? 1,
        })),
      },
      options: {
        responsive: true,
        plugins: {
          title: input.title ? { display: true, text: input.title } : { display: false },
          legend: { display: input.data.datasets.length > 1 },
        },
        ...input.options,
      },
    };

    // QuickChart accepts a JSON-encoded chart config in the URL — convenient
    // for cases where we need a renderable image without spinning up a headless
    // browser. URL length is bounded; for huge datasets, prefer client render.
    const encoded = encodeURIComponent(JSON.stringify(config));
    const imageUrl =
      encoded.length < 1500
        ? `https://quickchart.io/chart?w=600&h=400&c=${encoded}`
        : undefined;

    return { chartConfig: config, imageUrl };
  },
};

function defaultPalette(i: number): string {
  const palette = [
    'rgba(54, 162, 235, 0.6)',
    'rgba(255, 99, 132, 0.6)',
    'rgba(255, 206, 86, 0.6)',
    'rgba(75, 192, 192, 0.6)',
    'rgba(153, 102, 255, 0.6)',
    'rgba(255, 159, 64, 0.6)',
  ];
  return palette[i % palette.length];
}

function defaultBorder(i: number): string {
  return defaultPalette(i).replace('0.6', '1');
}
