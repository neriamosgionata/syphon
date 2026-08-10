import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import NewsTable from '../NewsTable.svelte';

afterEach(() => cleanup());

const analyses = [
  {
    ticker: { symbol: 'AAPL' },
    article: { id: 1, title: 'Apple earnings beat expectations' },
    sentiment: 'bullish',
    sentiment_score: 0.65,
    relevance_score: 0.82,
    confidence: 0.91,
    created_at: new Date(Date.now() - 5 * 60000).toISOString(),
  },
  {
    ticker: { symbol: 'TSLA' },
    article: { id: 2, title: 'Tesla unveils new model' },
    sentiment: 'bearish',
    sentimentScore: -0.4,
    relevanceScore: 0.7,
    confidence: 0.8,
    createdAt: new Date(Date.now() - 2 * 3600000).toISOString(),
  },
];

describe('NewsTable', () => {
  it('shows empty state when no analyses', () => {
    render(NewsTable, { props: { analyses: [] } });
    expect(screen.getByText('No analyses yet')).toBeInTheDocument();
  });

  it('renders column headers', () => {
    render(NewsTable, { props: { analyses } });
    expect(screen.getByText('Ticker')).toBeInTheDocument();
    expect(screen.getByText('Article')).toBeInTheDocument();
    expect(screen.getByText('Sentiment')).toBeInTheDocument();
    expect(screen.getByText('Relevance')).toBeInTheDocument();
    expect(screen.getByText('Confidence')).toBeInTheDocument();
  });

  it('renders ticker links', () => {
    render(NewsTable, { props: { analyses } });
    const link = screen.getByRole('link', { name: 'AAPL' });
    expect(link).toHaveAttribute('href', '/tickers/AAPL');
  });

  it('renders article links', () => {
    render(NewsTable, { props: { analyses } });
    const link = screen.getByRole('link', { name: 'Apple earnings beat expectations' });
    expect(link).toHaveAttribute('href', '/articles/1');
  });

  it('formats score and confidence', () => {
    render(NewsTable, { props: { analyses } });
    expect(screen.getByText('0.650')).toBeInTheDocument();
    expect(screen.getByText('0.820')).toBeInTheDocument();
    expect(screen.getByText('91.0%')).toBeInTheDocument();
  });

  it('supports camelCase fields', () => {
    render(NewsTable, { props: { analyses } });
    expect(screen.getByText('-0.400')).toBeInTheDocument();
    expect(screen.getByText('0.700')).toBeInTheDocument();
    expect(screen.getByText('80.0%')).toBeInTheDocument();
  });

  it('truncates long article titles', () => {
    const long = [{ ...analyses[0], article: { id: 9, title: 'y'.repeat(100) } }];
    render(NewsTable, { props: { analyses: long } });
    expect(screen.getByText((content) => content.includes('y'.repeat(60)))).toHaveTextContent('...');
  });

  it('falls back to article_id when article object missing', () => {
    const [a] = analyses;
    const data = [{ ...a, article: null, article_id: 77 }];
    const { container } = render(NewsTable, { props: { analyses: data } });
    const link = container.querySelector('a[href="/articles/77"]');
    expect(link).not.toBeNull();
  });

  it('renders sentiment badge labels', () => {
    render(NewsTable, { props: { analyses } });
    expect(screen.getByText('Bullish')).toBeInTheDocument();
    expect(screen.getByText('Bearish')).toBeInTheDocument();
  });
});
