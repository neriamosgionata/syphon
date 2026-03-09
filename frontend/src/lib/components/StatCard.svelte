<script lang="ts">
  interface Props {
    label: string;
    value: string | number;
    trend?: string;
  }

  let { label, value, trend }: Props = $props();
</script>

<div class="card stat-card">
  <div class="stat-label">{label}</div>
  <div class="stat-value">{value}</div>
  {#if trend}
    <div class="stat-trend" class:positive={trend.startsWith('+')} class:negative={trend.startsWith('-')}>
      {trend}
    </div>
  {/if}
</div>

<style>
  .stat-card {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .stat-trend {
    font-size: 0.85rem;
    font-weight: 600;
  }
  .stat-trend.positive { color: var(--green); }
  .stat-trend.negative { color: var(--red); }
</style>
