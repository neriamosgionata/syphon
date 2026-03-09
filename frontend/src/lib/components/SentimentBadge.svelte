<script lang="ts">
  interface Props {
    sentiment: string;
    score?: number;
  }

  let { sentiment, score }: Props = $props();

  const labels: Record<string, string> = {
    very_bullish: 'Very Bullish',
    bullish: 'Bullish',
    neutral: 'Neutral',
    bearish: 'Bearish',
    very_bearish: 'Very Bearish',
  };
</script>

<span class="badge {sentiment}" title={score != null ? `Score: ${score.toFixed(3)}` : ''}>
  {labels[sentiment] || sentiment}
</span>
