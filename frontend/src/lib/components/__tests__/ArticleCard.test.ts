import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import ArticleCard from '../ArticleCard.svelte';

afterEach(() => cleanup());

const baseArticle = {
  id: 42,
  title: 'Apple beats expectations in Q3',
  source_name: 'Google News',
  published_at: new Date(Date.now() - 5 * 60000).toISOString(),
  url: 'https://example.com/article',
};

describe('ArticleCard', () => {
  it('renders source and title', () => {
    render(ArticleCard, { props: { article: baseArticle } });
    expect(screen.getByText('Google News')).toBeInTheDocument();
    expect(screen.getByText('Apple beats expectations in Q3')).toBeInTheDocument();
  });

  it('links the title to the article page', () => {
    render(ArticleCard, { props: { article: baseArticle } });
    const link = screen.getByRole('link', { name: 'Apple beats expectations in Q3' });
    expect(link).toHaveAttribute('href', '/articles/42');
  });

  it('renders time as minutes ago', () => {
    render(ArticleCard, { props: { article: baseArticle } });
    expect(screen.getByText('5m ago')).toBeInTheDocument();
  });

  it('renders time as hours ago', () => {
    const article = { ...baseArticle, published_at: new Date(Date.now() - 3 * 3600000).toISOString() };
    render(ArticleCard, { props: { article } });
    expect(screen.getByText('3h ago')).toBeInTheDocument();
  });

  it('renders time as days ago', () => {
    const article = { ...baseArticle, published_at: new Date(Date.now() - 2 * 86400000).toISOString() };
    render(ArticleCard, { props: { article } });
    expect(screen.getByText('2d ago')).toBeInTheDocument();
  });

  it('renders empty time when no date', () => {
    const article = { ...baseArticle, published_at: null };
    const { container } = render(ArticleCard, { props: { article } });
    expect(container.querySelector('.time')?.textContent).toBe('');
  });

  it('renders summary and truncates long summaries', () => {
    const summary = 'x'.repeat(250);
    const article = { ...baseArticle, summary };
    render(ArticleCard, { props: { article } });
    const el = screen.getByText((content) => content.includes('x'.repeat(200)));
    expect(el).toHaveTextContent('...');
  });

  it('does not render summary section when absent', () => {
    const article = { ...baseArticle, summary: null };
    const { container } = render(ArticleCard, { props: { article } });
    expect(container.querySelector('.article-summary')).toBeNull();
  });

  it('renders analysis chips for analyzed articles', () => {
    const article = {
      ...baseArticle,
      analyses: [
        {
          sentiment: 'bullish',
          sentiment_score: 0.7,
          ticker: { symbol: 'AAPL' },
        },
      ],
    };
    render(ArticleCard, { props: { article } });
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('Bullish')).toBeInTheDocument();
  });

  it('shows pending state when unanalyzed without analyses', () => {
    const article = { ...baseArticle, is_analyzed: false, analyses: [] };
    render(ArticleCard, { props: { article } });
    expect(screen.getByText('Pending analysis')).toBeInTheDocument();
  });

  it('links the external source', () => {
    render(ArticleCard, { props: { article: baseArticle } });
    const link = screen.getByText('Source');
    expect(link).toHaveAttribute('href', 'https://example.com/article');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('supports camelCase article fields', () => {
    const article = {
      id: 7,
      title: 'CamelCase title',
      sourceName: 'CNBC',
      publishedAt: baseArticle.published_at,
      url: 'https://example.com/c',
      analyses: [],
      isAnalyzed: true,
    };
    render(ArticleCard, { props: { article } });
    expect(screen.getByText('CNBC')).toBeInTheDocument();
    expect(screen.getByText('CamelCase title')).toBeInTheDocument();
  });
});
