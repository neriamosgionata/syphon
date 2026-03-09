<script lang="ts">
  import '../app.css';
  import type { Snippet } from 'svelte';
  import NotificationToast from '$lib/components/NotificationToast.svelte';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();

  const navItems = [
    { href: '/', label: 'Dashboard' },
    { href: '/articles', label: 'Articles' },
    { href: '/tickers', label: 'Tickers' },
    { href: '/analysis', label: 'Analysis' },
    { href: '/trading', label: 'Trading' },
    { href: '/logs', label: 'Logs' },
  ];
</script>

<NotificationToast />

<div class="app">
  <nav class="navbar">
    <div class="container nav-inner">
      <a href="/" class="logo">Syphon</a>
      <div class="nav-links">
        {#each navItems as item}
          <a href={item.href} class="nav-link">{item.label}</a>
        {/each}
      </div>
    </div>
  </nav>
  <main class="container main-content">
    {@render children()}
  </main>
</div>

<style>
  .app {
    min-height: 100vh;
  }
  .navbar {
    background: var(--bg-card);
    border-bottom: 1px solid var(--border);
    padding: 0.75rem 0;
    position: sticky;
    top: 0;
    z-index: 100;
    backdrop-filter: blur(8px);
  }
  .nav-inner {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .logo {
    font-size: 1.25rem;
    font-weight: 800;
    color: var(--accent);
    letter-spacing: -0.02em;
  }
  .nav-links {
    display: flex;
    gap: 1.5rem;
  }
  .nav-link {
    color: var(--text-muted);
    font-size: 0.9rem;
    font-weight: 500;
    transition: color 0.15s;
  }
  .nav-link:hover {
    color: var(--text);
  }
  .main-content {
    padding-top: 2rem;
    padding-bottom: 3rem;
  }
</style>
