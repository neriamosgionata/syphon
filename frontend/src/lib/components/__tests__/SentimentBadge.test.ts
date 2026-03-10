import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import SentimentBadge from '../SentimentBadge.svelte';

afterEach(() => cleanup());

describe('SentimentBadge', () => {
  it('renders "Very Bullish" for very_bullish sentiment', () => {
    render(SentimentBadge, { props: { sentiment: 'very_bullish' } });
    expect(screen.getByText('Very Bullish')).toBeInTheDocument();
  });

  it('renders "Bullish" for bullish sentiment', () => {
    render(SentimentBadge, { props: { sentiment: 'bullish' } });
    expect(screen.getByText('Bullish')).toBeInTheDocument();
  });

  it('renders "Neutral" for neutral sentiment', () => {
    render(SentimentBadge, { props: { sentiment: 'neutral' } });
    expect(screen.getByText('Neutral')).toBeInTheDocument();
  });

  it('renders "Bearish" for bearish sentiment', () => {
    render(SentimentBadge, { props: { sentiment: 'bearish' } });
    expect(screen.getByText('Bearish')).toBeInTheDocument();
  });

  it('renders "Very Bearish" for very_bearish sentiment', () => {
    render(SentimentBadge, { props: { sentiment: 'very_bearish' } });
    expect(screen.getByText('Very Bearish')).toBeInTheDocument();
  });

  it('applies sentiment class to badge', () => {
    render(SentimentBadge, { props: { sentiment: 'bullish' } });
    const badge = screen.getByText('Bullish');
    expect(badge).toHaveClass('bullish');
    expect(badge).toHaveClass('badge');
  });

  it('shows score in title when provided', () => {
    render(SentimentBadge, { props: { sentiment: 'bullish', score: 0.456 } });
    const badge = screen.getByText('Bullish');
    expect(badge).toHaveAttribute('title', 'Score: 0.456');
  });

  it('has empty title when no score', () => {
    render(SentimentBadge, { props: { sentiment: 'neutral' } });
    const badge = screen.getByText('Neutral');
    expect(badge).toHaveAttribute('title', '');
  });

  it('falls back to raw value for unknown sentiment', () => {
    render(SentimentBadge, { props: { sentiment: 'unknown_value' } });
    expect(screen.getByText('unknown_value')).toBeInTheDocument();
  });
});
