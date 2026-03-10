import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import StatCard from '../StatCard.svelte';

afterEach(() => cleanup());

describe('StatCard', () => {
  it('renders label and value', () => {
    render(StatCard, { props: { label: 'Total Articles', value: 42 } });
    expect(screen.getByText('Total Articles')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('renders string value', () => {
    render(StatCard, { props: { label: 'Status', value: 'Active' } });
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('renders trend when provided', () => {
    render(StatCard, { props: { label: 'Price', value: 150, trend: '+5.2%' } });
    expect(screen.getByText('+5.2%')).toBeInTheDocument();
  });

  it('does not render trend when not provided', () => {
    const { container } = render(StatCard, { props: { label: 'Count', value: 10 } });
    expect(container.querySelector('.stat-trend')).toBeNull();
  });

  it('applies positive class for positive trend', () => {
    render(StatCard, { props: { label: 'Price', value: 150, trend: '+5%' } });
    const trend = screen.getByText('+5%');
    expect(trend).toHaveClass('positive');
  });

  it('applies negative class for negative trend', () => {
    render(StatCard, { props: { label: 'Price', value: 150, trend: '-3%' } });
    const trend = screen.getByText('-3%');
    expect(trend).toHaveClass('negative');
  });

  it('has stat-card class', () => {
    const { container } = render(StatCard, { props: { label: 'Test', value: 0 } });
    expect(container.querySelector('.stat-card')).toBeInTheDocument();
  });
});
