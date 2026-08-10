import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';

let capturedConfig: any = null;
let chartInstances = 0;

vi.mock('chart.js', () => ({
  Chart: class {
    static register() {}
    constructor(_canvas: any, config: any) {
      capturedConfig = config;
      chartInstances++;
    }
    destroy() {
      chartInstances--;
    }
  },
  registerables: [],
}));

import TickerChart from '../TickerChart.svelte';

afterEach(() => {
  cleanup();
  capturedConfig = null;
  chartInstances = 0;
});

const snapshots = [
  { date: '2026-08-01', close: 150 },
  { date: '2026-08-02', close: 152 },
  { date: '2026-08-03', close: 151 },
];

describe('TickerChart', () => {
  it('renders a canvas element', () => {
    const { container } = render(TickerChart, { props: { snapshots } });
    expect(container.querySelector('canvas')).not.toBeNull();
  });

  it('creates a chart with sorted price data', () => {
    render(TickerChart, { props: { snapshots: [...snapshots].reverse() } });

    expect(chartInstances).toBe(1);
    expect(capturedConfig.type).toBe('line');
    expect(capturedConfig.data.labels).toEqual(['2026-08-01', '2026-08-02', '2026-08-03']);
    expect(capturedConfig.data.datasets[0].data).toEqual([150, 152, 151]);
    expect(capturedConfig.data.datasets[0].label).toBe('Price');
  });

  it('uses the custom label for the price series', () => {
    render(TickerChart, { props: { snapshots, label: 'Close' } });
    expect(capturedConfig.data.datasets[0].label).toBe('Close');
  });

  it('does not create a chart without snapshots', () => {
    render(TickerChart, { props: { snapshots: [] } });
    expect(chartInstances).toBe(0);
  });

  it('adds a sentiment dataset when sentimentData is provided', () => {
    const sentimentData = [{ date: '2026-08-01', avg_sentiment: 0.5 }];
    render(TickerChart, { props: { snapshots, sentimentData } });

    expect(capturedConfig.data.datasets.length).toBe(2);
    expect(capturedConfig.data.datasets[1].label).toBe('Sentiment');
    expect(capturedConfig.data.datasets[1].data).toEqual([0.5, null, null]);
    expect(capturedConfig.options.scales.y1).toBeDefined();
  });

  it('omits the sentiment dataset when sentimentData is empty', () => {
    render(TickerChart, { props: { snapshots, sentimentData: [] } });

    expect(capturedConfig.data.datasets.length).toBe(1);
    expect(capturedConfig.options.scales.y1).toBeUndefined();
  });
});
