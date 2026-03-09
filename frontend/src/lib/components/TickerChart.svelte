<script lang="ts">
  import { onMount } from 'svelte';
  import { Chart, registerables } from 'chart.js';

  Chart.register(...registerables);

  interface Props {
    snapshots: any[];
    sentimentData?: any[];
    label?: string;
  }

  let { snapshots, sentimentData, label = 'Price' }: Props = $props();
  let canvas: HTMLCanvasElement;
  let chart: Chart | null = null;

  function buildChart() {
    if (chart) chart.destroy();
    if (!canvas || snapshots.length === 0) return;

    const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));
    const labels = sorted.map((s) => s.date);
    const prices = sorted.map((s) => s.close);

    const datasets: any[] = [
      {
        label,
        data: prices,
        borderColor: '#6366f1',
        backgroundColor: 'rgba(99, 102, 241, 0.1)',
        fill: true,
        tension: 0.3,
        yAxisID: 'y',
      },
    ];

    if (sentimentData && sentimentData.length > 0) {
      const sentimentMap = new Map(sentimentData.map((s: any) => [s.date, s.avg_sentiment]));
      const sentimentValues = labels.map((d) => sentimentMap.get(d) ?? null);
      datasets.push({
        label: 'Sentiment',
        data: sentimentValues,
        borderColor: '#22c55e',
        backgroundColor: 'rgba(34, 197, 94, 0.1)',
        borderDash: [5, 5],
        fill: false,
        tension: 0.3,
        yAxisID: 'y1',
      });
    }

    chart = new Chart(canvas, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: '#8b8fa3' } },
        },
        scales: {
          x: {
            ticks: { color: '#8b8fa3', maxTicksLimit: 12 },
            grid: { color: 'rgba(42, 46, 61, 0.5)' },
          },
          y: {
            position: 'left',
            ticks: { color: '#8b8fa3' },
            grid: { color: 'rgba(42, 46, 61, 0.5)' },
          },
          ...(sentimentData && sentimentData.length > 0
            ? {
                y1: {
                  position: 'right' as const,
                  ticks: { color: '#22c55e' },
                  grid: { display: false },
                },
              }
            : {}),
        },
      },
    });
  }

  onMount(() => {
    buildChart();
    return () => chart?.destroy();
  });

  $effect(() => {
    snapshots;
    sentimentData;
    buildChart();
  });
</script>

<div class="chart-container">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .chart-container {
    position: relative;
    height: 300px;
    width: 100%;
  }
</style>
