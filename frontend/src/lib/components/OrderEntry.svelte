<script lang="ts">
  import { api } from '$lib/api';

  interface Props {
    symbol: string;
    currentPrice?: number | null;
    analysisId?: number | null;
    onOrderPlaced?: (trade: any) => void;
  }

  let { symbol, currentPrice = null, analysisId = null, onOrderPlaced }: Props = $props();

  let side: 'BUY' | 'SELL' = $state('BUY');
  let orderType = $state('MKT');
  let quantity = $state(1);
  let limitPrice = $state(currentPrice || 0);
  let stopPrice = $state(0);
  let trailAmount = $state(1);
  let timeInForce = $state('DAY');
  let submitting = $state(false);
  let error = $state('');
  let success = $state('');

  $effect(() => {
    if (currentPrice && limitPrice === 0) {
      limitPrice = currentPrice;
    }
  });

  const estimatedCost = $derived(
    orderType === 'MKT'
      ? (currentPrice || 0) * quantity
      : (limitPrice || currentPrice || 0) * quantity
  );

  async function submit() {
    error = '';
    success = '';
    submitting = true;

    try {
      const payload: any = {
        symbol,
        side,
        order_type: orderType,
        quantity,
        time_in_force: timeInForce,
      };

      if (['LMT', 'STP_LMT'].includes(orderType)) payload.limit_price = limitPrice;
      if (['STP', 'STP_LMT'].includes(orderType)) payload.stop_price = stopPrice;
      if (orderType === 'TRAIL') payload.trail_amount = trailAmount;
      if (analysisId) payload.analysis_id = analysisId;

      const result = await api.placeOrder(payload);
      success = result.message || 'Order submitted';
      onOrderPlaced?.(result.trade);
    } catch (e: any) {
      error = e.message;
    } finally {
      submitting = false;
    }
  }
</script>

<div class="order-entry">
  <div class="order-header">
    <h3>Trade {symbol}</h3>
    {#if currentPrice}
      <span class="current-price">${currentPrice.toFixed(2)}</span>
    {/if}
  </div>

  <div class="side-toggle">
    <button
      class="side-btn buy"
      class:active={side === 'BUY'}
      onclick={() => side = 'BUY'}
    >Buy</button>
    <button
      class="side-btn sell"
      class:active={side === 'SELL'}
      onclick={() => side = 'SELL'}
    >Sell</button>
  </div>

  <div class="form-grid">
    <div class="field">
      <label for="order-type">Order Type</label>
      <select id="order-type" bind:value={orderType}>
        <option value="MKT">Market</option>
        <option value="LMT">Limit</option>
        <option value="STP">Stop</option>
        <option value="STP_LMT">Stop Limit</option>
        <option value="TRAIL">Trailing Stop</option>
      </select>
    </div>

    <div class="field">
      <label for="quantity">Quantity</label>
      <input id="quantity" type="number" min="1" step="1" bind:value={quantity} />
    </div>

    {#if ['LMT', 'STP_LMT'].includes(orderType)}
      <div class="field">
        <label for="limit-price">Limit Price</label>
        <input id="limit-price" type="number" min="0" step="0.01" bind:value={limitPrice} />
      </div>
    {/if}

    {#if ['STP', 'STP_LMT'].includes(orderType)}
      <div class="field">
        <label for="stop-price">Stop Price</label>
        <input id="stop-price" type="number" min="0" step="0.01" bind:value={stopPrice} />
      </div>
    {/if}

    {#if orderType === 'TRAIL'}
      <div class="field">
        <label for="trail-amount">Trail Amount ($)</label>
        <input id="trail-amount" type="number" min="0" step="0.01" bind:value={trailAmount} />
      </div>
    {/if}

    <div class="field">
      <label for="tif">Time in Force</label>
      <select id="tif" bind:value={timeInForce}>
        <option value="DAY">Day</option>
        <option value="GTC">Good 'til Cancelled</option>
        <option value="IOC">Immediate or Cancel</option>
        <option value="OPG">At Open</option>
      </select>
    </div>
  </div>

  <div class="order-summary">
    <div class="summary-row">
      <span>Estimated {side === 'BUY' ? 'Cost' : 'Proceeds'}</span>
      <strong>${estimatedCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
    </div>
  </div>

  {#if error}
    <div class="message error-msg">{error}</div>
  {/if}
  {#if success}
    <div class="message success-msg">{success}</div>
  {/if}

  <button
    class="submit-btn {side.toLowerCase()}"
    disabled={submitting || quantity <= 0}
    onclick={submit}
  >
    {submitting ? 'Submitting...' : `${side} ${quantity} ${symbol}`}
  </button>
</div>

<style>
  .order-entry {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .order-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .order-header h3 {
    margin: 0;
  }
  .current-price {
    font-size: 1.5rem;
    font-weight: 800;
    font-family: 'SF Mono', monospace;
  }
  .side-toggle {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0;
    border-radius: var(--radius);
    overflow: hidden;
    border: 1px solid var(--border);
  }
  .side-btn {
    padding: 0.6rem;
    border: none;
    background: var(--bg);
    color: var(--text-muted);
    font-weight: 700;
    font-size: 0.95rem;
    cursor: pointer;
    transition: all 0.15s;
  }
  .side-btn.buy.active {
    background: var(--green);
    color: white;
  }
  .side-btn.sell.active {
    background: var(--red);
    color: white;
  }
  .form-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .field label {
    font-size: 0.75rem;
    color: var(--text-muted);
    text-transform: uppercase;
    font-weight: 600;
  }
  .field input, .field select {
    width: 100%;
  }
  .order-summary {
    padding: 0.75rem;
    background: var(--bg);
    border-radius: var(--radius);
  }
  .summary-row {
    display: flex;
    justify-content: space-between;
    font-size: 0.9rem;
  }
  .message {
    padding: 0.5rem 0.75rem;
    border-radius: var(--radius);
    font-size: 0.85rem;
  }
  .error-msg {
    background: rgba(239, 68, 68, 0.15);
    color: var(--red);
    border: 1px solid rgba(239, 68, 68, 0.3);
  }
  .success-msg {
    background: rgba(34, 197, 94, 0.15);
    color: var(--green);
    border: 1px solid rgba(34, 197, 94, 0.3);
  }
  .submit-btn {
    width: 100%;
    padding: 0.75rem;
    border: none;
    border-radius: var(--radius);
    font-weight: 700;
    font-size: 1rem;
    cursor: pointer;
    transition: all 0.15s;
    color: white;
  }
  .submit-btn.buy {
    background: var(--green);
  }
  .submit-btn.buy:hover:not(:disabled) {
    background: #16a34a;
  }
  .submit-btn.sell {
    background: var(--red);
  }
  .submit-btn.sell:hover:not(:disabled) {
    background: #dc2626;
  }
  .submit-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
