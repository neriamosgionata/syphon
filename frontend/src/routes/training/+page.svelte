<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api';

  // ── State ─────────────────────────────────────────────────

  let health: any = $state(null);
  let modelInfo: any = $state(null);
  let trainConfig: any = $state(null);
  let trainStatus: any = $state(null);
  let backfillStatus: any = $state(null);
  let predictions: any[] = $state([]);
  let loading = $state(true);
  let error = $state('');

  // Training form
  let trainPairs = $state('');
  let trainEpochs = $state(100);
  let trainBatchSize = $state(256);
  let trainLR = $state(0.0001);
  let trainSubmitting = $state(false);

  // Backfill form
  let backfillPairs = $state('');
  let backfillDays = $state(90);
  let backfillSubmitting = $state(false);

  // Predict form
  let predictPair = $state('XXBTZUSD');
  let predicting = $state(false);

  // Tabs
  let activeTab = $state<'overview' | 'train' | 'predict'>('overview');

  // Polling
  let pollInterval: ReturnType<typeof setInterval> | null = null;

  const ALL_PAIRS = [
    { value: 'XXBTZUSD', label: 'BTC/USD' },
    { value: 'XETHZUSD', label: 'ETH/USD' },
    { value: 'SOLUSD', label: 'SOL/USD' },
    { value: 'XRPUSD', label: 'XRP/USD' },
    { value: 'ADAUSD', label: 'ADA/USD' },
    { value: 'DOTUSD', label: 'DOT/USD' },
    { value: 'LINKUSD', label: 'LINK/USD' },
    { value: 'AVAXUSD', label: 'AVAX/USD' },
  ];

  // ── Data loading ──────────────────────────────────────────

  async function loadAll() {
    try {
      const [h, m, c, ts, bs] = await Promise.all([
        api.trainingHealth().catch(() => ({ status: 'offline' })),
        api.trainingModel().catch(() => null),
        api.trainingConfig().catch(() => null),
        api.trainingStatus().catch(() => ({ running: false })),
        api.trainingBackfillStatus().catch(() => ({ running: false })),
      ]);
      health = h;
      modelInfo = m?.error ? null : m;
      trainConfig = c?.error ? null : c;
      trainStatus = ts;
      backfillStatus = bs;
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  async function pollStatus() {
    try {
      const [ts, bs] = await Promise.all([
        api.trainingStatus().catch(() => null),
        api.trainingBackfillStatus().catch(() => null),
      ]);
      if (ts) trainStatus = ts;
      if (bs) backfillStatus = bs;

      // Stop fast polling if both done
      if (!trainStatus?.running && !backfillStatus?.running && pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
        // Refresh model info in case training finished
        const m = await api.trainingModel().catch(() => null);
        if (m && !m.error) modelInfo = m;
      }
    } catch {}
  }

  function startPolling() {
    if (pollInterval) return;
    pollInterval = setInterval(pollStatus, 2000);
  }

  // ── Actions ───────────────────────────────────────────────

  async function startTraining() {
    trainSubmitting = true;
    error = '';
    try {
      const params: any = {};
      if (trainPairs.trim()) {
        params.pairs = trainPairs.split(',').map((s: string) => s.trim()).filter(Boolean);
      }
      if (trainEpochs !== 100) params.epochs = trainEpochs;
      if (trainBatchSize !== 256) params.batch_size = trainBatchSize;
      if (trainLR !== 0.0001) params.learning_rate = trainLR;

      await api.trainingStart(params);
      startPolling();
      await pollStatus();
    } catch (e: any) {
      error = e.message;
    } finally {
      trainSubmitting = false;
    }
  }

  async function startBackfill() {
    backfillSubmitting = true;
    error = '';
    try {
      const params: any = { days: backfillDays };
      if (backfillPairs.trim()) {
        params.pairs = backfillPairs.split(',').map((s: string) => s.trim()).filter(Boolean);
      }
      await api.trainingBackfill(params);
      startPolling();
      await pollStatus();
    } catch (e: any) {
      error = e.message;
    } finally {
      backfillSubmitting = false;
    }
  }

  async function runPrediction() {
    predicting = true;
    error = '';
    try {
      const result = await api.trainingPredict(predictPair);
      predictions = [result, ...predictions.slice(0, 19)];
    } catch (e: any) {
      error = e.message;
    } finally {
      predicting = false;
    }
  }

  async function runBatchPredictions() {
    predicting = true;
    error = '';
    try {
      const pairs = ALL_PAIRS.map((p) => p.value);
      const result = await api.trainingPredictBatch(pairs);
      predictions = [...(result.predictions || []), ...predictions].slice(0, 30);
    } catch (e: any) {
      error = e.message;
    } finally {
      predicting = false;
    }
  }

  // ── Helpers ───────────────────────────────────────────────

  function pairLabel(pair: string): string {
    return ALL_PAIRS.find((p) => p.value === pair)?.label || pair;
  }

  function directionColor(dir: string): string {
    if (dir === 'up') return 'var(--green)';
    if (dir === 'down') return 'var(--red)';
    return 'var(--text-muted)';
  }

  function formatPct(val: number): string {
    return (val * 100).toFixed(3) + '%';
  }

  function formatProb(val: number): string {
    return (val * 100).toFixed(1) + '%';
  }

  function foldProgress(progress: any): string {
    if (!progress || !progress.fold) return '';
    return `Fold ${progress.fold}/${progress.total_folds} - Epoch ${progress.epoch}/${progress.total_epochs}`;
  }

  let isOnline = $derived(health?.status === 'ok');
  let isTraining = $derived(trainStatus?.running === true);
  let isBackfilling = $derived(backfillStatus?.running === true);

  onMount(() => {
    loadAll();
    // Start polling if something is running
    const checkPoll = setInterval(() => {
      if ((trainStatus?.running || backfillStatus?.running) && !pollInterval) {
        startPolling();
      }
    }, 5000);
    return () => {
      if (pollInterval) clearInterval(pollInterval);
      clearInterval(checkPoll);
    };
  });
</script>

<svelte:head>
  <title>Training - Syphon</title>
</svelte:head>

<div class="page">
  <div class="page-header">
    <div class="header-left">
      <h1>Neural Network Training</h1>
      <span class="status-badge" class:online={isOnline} class:offline={!isOnline}>
        {isOnline ? 'Online' : 'Offline'}
      </span>
    </div>
    <button class="btn" onclick={loadAll}>Refresh</button>
  </div>

  {#if error}
    <div class="error-banner">{error}
      <button class="error-dismiss" onclick={() => error = ''}>&times;</button>
    </div>
  {/if}

  {#if loading}
    <div class="loading">Connecting to training service...</div>
  {:else}
    <!-- Status Cards -->
    <div class="grid grid-4" style="margin-bottom: 1.5rem;">
      <div class="stat-card">
        <div class="stat-label">Service</div>
        <div class="stat-value" style="color: {isOnline ? 'var(--green)' : 'var(--red)'}">{isOnline ? 'Connected' : 'Unavailable'}</div>
        {#if health?.device}
          <div class="stat-sub">{health.device}</div>
        {/if}
      </div>
      <div class="stat-card">
        <div class="stat-label">Model</div>
        <div class="stat-value">{modelInfo ? 'Loaded' : 'No model'}</div>
        {#if modelInfo?.trained_at && modelInfo.trained_at !== 'unknown'}
          <div class="stat-sub">Trained: {new Date(modelInfo.trained_at).toLocaleDateString()}</div>
        {/if}
      </div>
      <div class="stat-card">
        <div class="stat-label">Training</div>
        <div class="stat-value" style="color: {isTraining ? 'var(--accent)' : 'var(--text-muted)'}">{isTraining ? 'Running' : 'Idle'}</div>
        {#if isTraining && trainStatus?.progress}
          <div class="stat-sub">{foldProgress(trainStatus.progress)}</div>
        {/if}
      </div>
      <div class="stat-card">
        <div class="stat-label">Backfill</div>
        <div class="stat-value" style="color: {isBackfilling ? 'var(--accent)' : 'var(--text-muted)'}">{isBackfilling ? 'Running' : 'Idle'}</div>
        {#if isBackfilling && backfillStatus?.current_pair}
          <div class="stat-sub">Fetching {pairLabel(backfillStatus.current_pair)}</div>
        {/if}
      </div>
    </div>

    <!-- Tabs -->
    <div class="tabs">
      <button class="tab" class:active={activeTab === 'overview'} onclick={() => activeTab = 'overview'}>Overview</button>
      <button class="tab" class:active={activeTab === 'train'} onclick={() => activeTab = 'train'}>Train & Backfill</button>
      <button class="tab" class:active={activeTab === 'predict'} onclick={() => activeTab = 'predict'}>Predictions</button>
    </div>

    <!-- Tab: Overview -->
    {#if activeTab === 'overview'}
      <div class="grid grid-2" style="margin-top: 1.5rem;">
        <!-- Model Info -->
        <div class="card">
          <h3 style="margin-bottom: 1rem;">Model Info</h3>
          {#if modelInfo}
            <div class="info-rows">
              <div class="info-row"><span>Version</span><span>{modelInfo.version || '-'}</span></div>
              <div class="info-row"><span>Architecture</span><span>Transformer {modelInfo.d_model || 128}d / {modelInfo.num_layers || 4}L</span></div>
              <div class="info-row"><span>Sequence Length</span><span>{modelInfo.seq_len || 120} bars (5-min)</span></div>
              <div class="info-row"><span>Training Fold</span><span>{modelInfo.fold != null ? `#${modelInfo.fold + 1}` : '-'}</span></div>
              <div class="info-row"><span>Epoch</span><span>{modelInfo.epoch || '-'}</span></div>
              {#if modelInfo.pairs_configured?.length}
                <div class="info-row"><span>Pairs</span><span>{modelInfo.pairs_configured.map(pairLabel).join(', ')}</span></div>
              {/if}
            </div>
            {#if modelInfo.val_metrics}
              <h4 style="margin: 1rem 0 0.5rem;">Validation Metrics</h4>
              <div class="info-rows">
                {#if modelInfo.val_metrics.direction_accuracy != null}
                  <div class="info-row"><span>Direction Accuracy</span><span>{(modelInfo.val_metrics.direction_accuracy * 100).toFixed(1)}%</span></div>
                {/if}
                {#if modelInfo.val_metrics.sharpe != null}
                  <div class="info-row"><span>Sharpe Ratio</span><span>{modelInfo.val_metrics.sharpe.toFixed(2)}</span></div>
                {/if}
                {#if modelInfo.val_metrics.win_rate != null}
                  <div class="info-row"><span>Win Rate</span><span>{(modelInfo.val_metrics.win_rate * 100).toFixed(1)}%</span></div>
                {/if}
                {#if modelInfo.val_metrics.profitable_dir_acc != null}
                  <div class="info-row"><span>Profitable Direction</span><span>{(modelInfo.val_metrics.profitable_dir_acc * 100).toFixed(1)}%</span></div>
                {/if}
                {#if modelInfo.val_metrics.corr_3h != null}
                  <div class="info-row"><span>Return Corr (3h)</span><span>{modelInfo.val_metrics.corr_3h.toFixed(3)}</span></div>
                {/if}
                {#if modelInfo.val_metrics.max_drawdown != null}
                  <div class="info-row"><span>Max Drawdown</span><span>{(modelInfo.val_metrics.max_drawdown * 100).toFixed(2)}%</span></div>
                {/if}
              </div>
            {/if}
          {:else}
            <div class="empty">No model loaded. Train a model first or check the training service.</div>
          {/if}
        </div>

        <!-- Config -->
        <div class="card">
          <h3 style="margin-bottom: 1rem;">Configuration</h3>
          {#if trainConfig}
            <div class="config-sections">
              {#if trainConfig.data}
                <div class="config-section">
                  <h4>Data</h4>
                  <div class="info-rows">
                    <div class="info-row"><span>Pairs</span><span>{(trainConfig.data.pairs || []).map(pairLabel).join(', ') || '-'}</span></div>
                    <div class="info-row"><span>Interval</span><span>{trainConfig.data.interval || 5}m</span></div>
                    <div class="info-row"><span>Sequence Length</span><span>{trainConfig.data.seq_len || 120}</span></div>
                    <div class="info-row"><span>Backfill Days</span><span>{trainConfig.data.backfill_days || 90}</span></div>
                  </div>
                </div>
              {/if}
              {#if trainConfig.model}
                <div class="config-section">
                  <h4>Model</h4>
                  <div class="info-rows">
                    <div class="info-row"><span>d_model</span><span>{trainConfig.model.d_model || 128}</span></div>
                    <div class="info-row"><span>Heads</span><span>{trainConfig.model.nhead || 8}</span></div>
                    <div class="info-row"><span>Layers</span><span>{trainConfig.model.num_layers || 4}</span></div>
                    <div class="info-row"><span>FFN dim</span><span>{trainConfig.model.dim_feedforward || 256}</span></div>
                    <div class="info-row"><span>Dropout</span><span>{trainConfig.model.dropout || 0.1}</span></div>
                  </div>
                </div>
              {/if}
              {#if trainConfig.training}
                <div class="config-section">
                  <h4>Training</h4>
                  <div class="info-rows">
                    <div class="info-row"><span>Batch Size</span><span>{trainConfig.training.batch_size || 256}</span></div>
                    <div class="info-row"><span>Epochs</span><span>{trainConfig.training.epochs || 100}</span></div>
                    <div class="info-row"><span>Learning Rate</span><span>{trainConfig.training.lr || 1e-4}</span></div>
                    <div class="info-row"><span>Walk-forward Train</span><span>{trainConfig.training.walk_forward_train_days || 30} days</span></div>
                    <div class="info-row"><span>Validation</span><span>{trainConfig.training.val_days || 7} days</span></div>
                    <div class="info-row"><span>Patience</span><span>{trainConfig.training.patience || 10}</span></div>
                  </div>
                </div>
              {/if}
            </div>
          {:else}
            <div class="empty">Cannot load configuration. Is the training service running?</div>
          {/if}
        </div>
      </div>

      <!-- Training Status (when running or completed) -->
      {#if trainStatus && (trainStatus.running || trainStatus.summary || trainStatus.error)}
        <div class="card" style="margin-top: 1.5rem;">
          <h3 style="margin-bottom: 1rem;">Training Status</h3>
          {#if trainStatus.running}
            <div class="training-live">
              <div class="pulse-dot"></div>
              <div class="training-progress">
                {#if trainStatus.progress?.fold}
                  <div class="tp-main">
                    Fold {trainStatus.progress.fold}/{trainStatus.progress.total_folds} &mdash;
                    Epoch {trainStatus.progress.epoch}/{trainStatus.progress.total_epochs}
                  </div>
                  <div class="tp-metrics">
                    {#if trainStatus.progress.direction_accuracy != null}
                      <span>Acc: {(trainStatus.progress.direction_accuracy * 100).toFixed(1)}%</span>
                    {/if}
                    {#if trainStatus.progress.sharpe != null}
                      <span>Sharpe: {trainStatus.progress.sharpe.toFixed(2)}</span>
                    {/if}
                    {#if trainStatus.progress.train_loss != null}
                      <span>Loss: {trainStatus.progress.train_loss.toFixed(4)}</span>
                    {/if}
                    {#if trainStatus.progress.val_loss != null}
                      <span>Val Loss: {trainStatus.progress.val_loss.toFixed(4)}</span>
                    {/if}
                  </div>
                  <div class="tp-bar-track">
                    <div class="tp-bar-fill" style="width: {(((trainStatus.progress.fold - 1) * trainStatus.progress.total_epochs + trainStatus.progress.epoch) / (trainStatus.progress.total_folds * trainStatus.progress.total_epochs) * 100).toFixed(1)}%"></div>
                  </div>
                {:else}
                  <div class="tp-main">Initializing...</div>
                {/if}
              </div>
            </div>
          {:else if trainStatus.error}
            <div class="error-box">Training failed: {trainStatus.error}</div>
          {:else if trainStatus.summary}
            <div class="info-rows">
              <div class="info-row"><span>Status</span><span style="color: var(--green)">Completed</span></div>
              <div class="info-row"><span>Folds</span><span>{trainStatus.summary.folds_completed}/{trainStatus.summary.total_folds}</span></div>
              <div class="info-row"><span>Best Score</span><span>{trainStatus.summary.best_score?.toFixed(4) || '-'}</span></div>
              <div class="info-row"><span>Duration</span><span>{Math.round((trainStatus.summary.training_time_seconds || 0) / 60)}min</span></div>
              {#if trainStatus.summary.best_model_path}
                <div class="info-row"><span>Model</span><span class="path">{trainStatus.summary.best_model_path}</span></div>
              {/if}
            </div>
            {#if trainStatus.summary.fold_results?.length}
              <h4 style="margin: 1rem 0 0.5rem;">Fold Results</h4>
              <div class="fold-table-scroll">
                <table class="fold-table">
                  <thead>
                    <tr><th>Fold</th><th>Train Period</th><th>Val Period</th><th>Epochs</th><th>Score</th></tr>
                  </thead>
                  <tbody>
                    {#each trainStatus.summary.fold_results as fold}
                      <tr>
                        <td>{fold.fold}</td>
                        <td>{fold.train_period}</td>
                        <td>{fold.val_period}</td>
                        <td>{fold.epochs_trained}</td>
                        <td>{fold.best_score?.toFixed(4) || '-'}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {/if}
          {/if}
        </div>
      {/if}

      <!-- Backfill Status -->
      {#if backfillStatus && (backfillStatus.running || backfillStatus.pairs_done?.length)}
        <div class="card" style="margin-top: 1.5rem;">
          <h3 style="margin-bottom: 1rem;">Backfill Status</h3>
          {#if backfillStatus.running}
            <div class="training-live">
              <div class="pulse-dot"></div>
              <span>Fetching <strong>{pairLabel(backfillStatus.current_pair || '')}</strong>...</span>
            </div>
          {/if}
          {#if backfillStatus.pairs_done?.length}
            <div class="info-rows" style="margin-top: {backfillStatus.running ? '0.75rem' : '0'}">
              {#each backfillStatus.pairs_done as p}
                <div class="info-row">
                  <span>{pairLabel(p.pair)}</span>
                  <span style="color: {p.status === 'ok' ? 'var(--green)' : 'var(--red)'}">
                    {p.status === 'ok' ? `${p.bars.toLocaleString()} bars` : p.status}
                  </span>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

    <!-- Tab: Train & Backfill -->
    {:else if activeTab === 'train'}
      <div class="grid grid-2" style="margin-top: 1.5rem;">
        <!-- Backfill Form -->
        <div class="card">
          <h3 style="margin-bottom: 1rem;">Backfill OHLC Data</h3>
          <p class="form-desc">Fetch historical 5-minute bars from Kraken. Required before training.</p>
          <div class="form-group">
            <label for="bf-pairs">Pairs (comma-separated, blank = all configured)</label>
            <input id="bf-pairs" type="text" bind:value={backfillPairs} placeholder="XXBTZUSD,XETHZUSD,...">
            <div class="pair-chips">
              {#each ALL_PAIRS as p}
                <button
                  class="pair-chip"
                  class:selected={backfillPairs.includes(p.value)}
                  onclick={() => {
                    const current = backfillPairs.split(',').map(s => s.trim()).filter(Boolean);
                    if (current.includes(p.value)) {
                      backfillPairs = current.filter(s => s !== p.value).join(',');
                    } else {
                      backfillPairs = [...current, p.value].join(',');
                    }
                  }}
                >{p.label}</button>
              {/each}
            </div>
          </div>
          <div class="form-group">
            <label for="bf-days">Days of history</label>
            <input id="bf-days" type="number" bind:value={backfillDays} min="7" max="365">
          </div>
          <button class="btn btn-primary" onclick={startBackfill} disabled={backfillSubmitting || isBackfilling || !isOnline}>
            {isBackfilling ? 'Backfilling...' : backfillSubmitting ? 'Starting...' : 'Start Backfill'}
          </button>
        </div>

        <!-- Train Form -->
        <div class="card">
          <h3 style="margin-bottom: 1rem;">Train Model</h3>
          <p class="form-desc">Walk-forward training on backfilled data. Produces a TradingTransformer checkpoint.</p>
          <div class="form-group">
            <label for="tr-pairs">Pairs (blank = all configured)</label>
            <input id="tr-pairs" type="text" bind:value={trainPairs} placeholder="XXBTZUSD,XETHZUSD,...">
            <div class="pair-chips">
              {#each ALL_PAIRS as p}
                <button
                  class="pair-chip"
                  class:selected={trainPairs.includes(p.value)}
                  onclick={() => {
                    const current = trainPairs.split(',').map(s => s.trim()).filter(Boolean);
                    if (current.includes(p.value)) {
                      trainPairs = current.filter(s => s !== p.value).join(',');
                    } else {
                      trainPairs = [...current, p.value].join(',');
                    }
                  }}
                >{p.label}</button>
              {/each}
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label for="tr-epochs">Max Epochs</label>
              <input id="tr-epochs" type="number" bind:value={trainEpochs} min="1" max="500">
            </div>
            <div class="form-group">
              <label for="tr-batch">Batch Size</label>
              <input id="tr-batch" type="number" bind:value={trainBatchSize} min="16" step="16">
            </div>
            <div class="form-group">
              <label for="tr-lr">Learning Rate</label>
              <input id="tr-lr" type="number" bind:value={trainLR} min="0.000001" max="0.01" step="0.00001">
            </div>
          </div>
          <button class="btn btn-primary" onclick={startTraining} disabled={trainSubmitting || isTraining || !isOnline}>
            {isTraining ? 'Training in progress...' : trainSubmitting ? 'Starting...' : 'Start Training'}
          </button>
        </div>
      </div>

    <!-- Tab: Predictions -->
    {:else if activeTab === 'predict'}
      <div style="margin-top: 1.5rem;">
        <div class="card" style="margin-bottom: 1.5rem;">
          <h3 style="margin-bottom: 1rem;">Run Prediction</h3>
          <div class="predict-controls">
            <div class="form-group" style="flex: 1; margin-bottom: 0;">
              <select bind:value={predictPair}>
                {#each ALL_PAIRS as p}
                  <option value={p.value}>{p.label} ({p.value})</option>
                {/each}
              </select>
            </div>
            <button class="btn btn-primary" onclick={runPrediction} disabled={predicting || !isOnline || !modelInfo}>
              {predicting ? 'Predicting...' : 'Predict'}
            </button>
            <button class="btn" onclick={runBatchPredictions} disabled={predicting || !isOnline || !modelInfo}>
              Predict All
            </button>
          </div>
          {#if !modelInfo}
            <div class="empty" style="margin-top: 0.75rem;">No model loaded. Train a model first.</div>
          {/if}
        </div>

        {#if predictions.length > 0}
          <div class="card">
            <h3 style="margin-bottom: 1rem;">Results</h3>
            <div class="pred-table-scroll">
              <table class="pred-table">
                <thead>
                  <tr>
                    <th>Pair</th>
                    <th>Direction</th>
                    <th>Confidence</th>
                    <th>Down</th>
                    <th>Flat</th>
                    <th>Up</th>
                    <th>R 30m</th>
                    <th>R 1h</th>
                    <th>R 3h</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {#each predictions as pred}
                    <tr>
                      <td><strong>{pairLabel(pred.pair)}</strong></td>
                      <td>
                        <span class="dir-badge" style="color: {directionColor(pred.direction)}">
                          {pred.direction === 'up' ? '&#9650;' : pred.direction === 'down' ? '&#9660;' : '&#9644;'}
                          {pred.direction}
                        </span>
                      </td>
                      <td>
                        <div class="conf-bar">
                          <div class="conf-fill" style="width: {pred.confidence * 100}%"></div>
                          <span class="conf-text">{formatProb(pred.confidence)}</span>
                        </div>
                      </td>
                      <td class="prob-cell" style="color: var(--red)">{formatProb(pred.direction_probs.down)}</td>
                      <td class="prob-cell">{formatProb(pred.direction_probs.flat)}</td>
                      <td class="prob-cell" style="color: var(--green)">{formatProb(pred.direction_probs.up)}</td>
                      <td class="ret-cell" style="color: {pred.returns.r30m > 0 ? 'var(--green)' : pred.returns.r30m < 0 ? 'var(--red)' : 'inherit'}">{formatPct(pred.returns.r30m)}</td>
                      <td class="ret-cell" style="color: {pred.returns.r1h > 0 ? 'var(--green)' : pred.returns.r1h < 0 ? 'var(--red)' : 'inherit'}">{formatPct(pred.returns.r1h)}</td>
                      <td class="ret-cell" style="color: {pred.returns.r3h > 0 ? 'var(--green)' : pred.returns.r3h < 0 ? 'var(--red)' : 'inherit'}">{formatPct(pred.returns.r3h)}</td>
                      <td class="time-cell">{new Date(pred.timestamp).toLocaleTimeString()}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
  }
  .header-left {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .status-badge {
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.2rem 0.6rem;
    border-radius: 20px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .status-badge.online {
    color: var(--green);
    background: rgba(34, 197, 94, 0.1);
    border: 1px solid rgba(34, 197, 94, 0.3);
  }
  .status-badge.offline {
    color: var(--red);
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.3);
  }

  .error-banner {
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.3);
    color: var(--red);
    padding: 0.75rem 1rem;
    border-radius: var(--radius);
    margin-bottom: 1rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.85rem;
  }
  .error-dismiss {
    background: none;
    border: none;
    color: var(--red);
    cursor: pointer;
    font-size: 1.2rem;
    padding: 0 0.3rem;
  }
  .error-box {
    background: rgba(239, 68, 68, 0.08);
    border: 1px solid rgba(239, 68, 68, 0.2);
    color: var(--red);
    padding: 0.75rem;
    border-radius: var(--radius);
    font-size: 0.85rem;
  }

  /* Stat Cards */
  .stat-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1rem 1.25rem;
  }
  .stat-label {
    font-size: 0.75rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: 0.25rem;
  }
  .stat-value {
    font-size: 1.1rem;
    font-weight: 700;
  }
  .stat-sub {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin-top: 0.15rem;
  }

  /* Tabs */
  .tabs {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--border);
  }
  .tab {
    background: none;
    border: none;
    padding: 0.6rem 1.25rem;
    font-size: 0.9rem;
    font-weight: 500;
    color: var(--text-muted);
    cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: all 0.15s;
    font-family: inherit;
  }
  .tab:hover {
    color: var(--text);
  }
  .tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }

  /* Info Rows */
  .info-rows {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }
  .info-row {
    display: flex;
    justify-content: space-between;
    font-size: 0.85rem;
  }
  .info-row span:first-child {
    color: var(--text-muted);
  }
  .path {
    font-family: 'SF Mono', monospace;
    font-size: 0.75rem;
    word-break: break-all;
  }

  /* Config sections */
  .config-sections {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }
  .config-section h4 {
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--accent);
    margin-bottom: 0.5rem;
  }

  /* Training live indicator */
  .training-live {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .pulse-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--accent);
    animation: pulse 1.5s ease-in-out infinite;
    flex-shrink: 0;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.4); }
    50% { opacity: 0.7; box-shadow: 0 0 0 6px rgba(99, 102, 241, 0); }
  }
  .training-progress {
    flex: 1;
  }
  .tp-main {
    font-weight: 600;
    font-size: 0.9rem;
    margin-bottom: 0.25rem;
  }
  .tp-metrics {
    display: flex;
    gap: 1rem;
    font-size: 0.8rem;
    color: var(--text-muted);
    font-family: 'SF Mono', monospace;
    margin-bottom: 0.5rem;
  }
  .tp-bar-track {
    height: 6px;
    background: var(--border);
    border-radius: 3px;
    overflow: hidden;
  }
  .tp-bar-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 3px;
    transition: width 0.5s;
  }

  /* Forms */
  .form-desc {
    font-size: 0.8rem;
    color: var(--text-muted);
    margin-bottom: 1rem;
    line-height: 1.5;
  }
  .form-group {
    margin-bottom: 1rem;
  }
  .form-group label {
    display: block;
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--text-muted);
    margin-bottom: 0.35rem;
  }
  .form-group input, .form-group select {
    width: 100%;
    padding: 0.5rem 0.75rem;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text);
    font-size: 0.85rem;
    font-family: inherit;
  }
  .form-group input:focus, .form-group select:focus {
    outline: none;
    border-color: var(--accent);
  }
  .form-row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.75rem;
  }

  /* Pair chips */
  .pair-chips {
    display: flex;
    gap: 0.35rem;
    flex-wrap: wrap;
    margin-top: 0.5rem;
  }
  .pair-chip {
    font-size: 0.72rem;
    padding: 0.2rem 0.5rem;
    border-radius: 20px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text-muted);
    cursor: pointer;
    transition: all 0.15s;
    font-family: inherit;
  }
  .pair-chip:hover {
    border-color: var(--accent);
    color: var(--text);
  }
  .pair-chip.selected {
    background: rgba(99, 102, 241, 0.15);
    border-color: var(--accent);
    color: var(--accent);
    font-weight: 600;
  }

  /* Fold table */
  .fold-table-scroll {
    overflow-x: auto;
  }
  .fold-table {
    width: 100%;
    font-size: 0.8rem;
  }

  /* Predictions */
  .predict-controls {
    display: flex;
    gap: 0.75rem;
    align-items: flex-end;
  }
  .predict-controls select {
    width: 100%;
    padding: 0.5rem 0.75rem;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text);
    font-size: 0.85rem;
    font-family: inherit;
  }
  .pred-table-scroll {
    overflow-x: auto;
  }
  .pred-table {
    width: 100%;
    font-size: 0.8rem;
    white-space: nowrap;
  }
  .pred-table th {
    text-align: left;
  }
  .dir-badge {
    font-weight: 700;
    text-transform: uppercase;
    font-size: 0.75rem;
    letter-spacing: 0.03em;
  }
  .conf-bar {
    position: relative;
    height: 20px;
    min-width: 80px;
    background: var(--border);
    border-radius: 3px;
    overflow: hidden;
  }
  .conf-fill {
    height: 100%;
    background: rgba(99, 102, 241, 0.3);
    border-radius: 3px;
  }
  .conf-text {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.7rem;
    font-weight: 600;
    font-family: 'SF Mono', monospace;
  }
  .prob-cell, .ret-cell {
    font-family: 'SF Mono', monospace;
    font-size: 0.75rem;
  }
  .time-cell {
    font-size: 0.7rem;
    color: var(--text-muted);
  }
</style>
