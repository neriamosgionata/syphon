import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import OrderEntry from '../OrderEntry.svelte';

afterEach(() => cleanup());

vi.mock('$lib/api', () => ({
  api: {
    placeOrder: vi.fn(),
  },
}));

import { api } from '$lib/api';

beforeEach(() => {
  vi.mocked(api.placeOrder).mockReset();
});

describe('OrderEntry', () => {
  it('renders trade header with symbol', () => {
    render(OrderEntry, { props: { symbol: 'AAPL' } });
    expect(screen.getByText('Trade AAPL')).toBeInTheDocument();
  });

  it('displays current price when provided', () => {
    const { container } = render(OrderEntry, { props: { symbol: 'AAPL', currentPrice: 175.50 } });
    const priceEl = container.querySelector('.current-price');
    expect(priceEl).toBeInTheDocument();
    expect(priceEl?.textContent).toBe('$175.50');
  });

  it('renders Buy and Sell buttons', () => {
    render(OrderEntry, { props: { symbol: 'AAPL' } });
    expect(screen.getByText('Buy')).toBeInTheDocument();
    expect(screen.getByText('Sell')).toBeInTheDocument();
  });

  it('renders order type options', () => {
    render(OrderEntry, { props: { symbol: 'AAPL' } });
    expect(screen.getByText('Market')).toBeInTheDocument();
    expect(screen.getByText('Limit')).toBeInTheDocument();
    expect(screen.getByText('Stop')).toBeInTheDocument();
    expect(screen.getByText('Stop Limit')).toBeInTheDocument();
    expect(screen.getByText('Trailing Stop')).toBeInTheDocument();
  });

  it('renders time in force options', () => {
    render(OrderEntry, { props: { symbol: 'AAPL' } });
    expect(screen.getByText('Day')).toBeInTheDocument();
    expect(screen.getByText("Good 'til Cancelled")).toBeInTheDocument();
    expect(screen.getByText('Immediate or Cancel')).toBeInTheDocument();
    expect(screen.getByText('At Open')).toBeInTheDocument();
  });

  it('submit button shows BUY by default', () => {
    render(OrderEntry, { props: { symbol: 'AAPL' } });
    expect(screen.getByText('BUY 1 AAPL')).toBeInTheDocument();
  });

  it('submit button updates when side changes to SELL', async () => {
    render(OrderEntry, { props: { symbol: 'AAPL' } });
    await fireEvent.click(screen.getByText('Sell'));
    expect(screen.getByText('SELL 1 AAPL')).toBeInTheDocument();
  });

  it('shows estimated cost label for BUY', () => {
    render(OrderEntry, { props: { symbol: 'AAPL', currentPrice: 100 } });
    expect(screen.getByText('Estimated Cost')).toBeInTheDocument();
  });

  it('shows estimated proceeds label for SELL', async () => {
    render(OrderEntry, { props: { symbol: 'AAPL', currentPrice: 100 } });
    await fireEvent.click(screen.getByText('Sell'));
    expect(screen.getByText('Estimated Proceeds')).toBeInTheDocument();
  });

  it('calls api.placeOrder on submit', async () => {
    vi.mocked(api.placeOrder).mockResolvedValue({ trade: {}, message: 'Order submitted' });

    render(OrderEntry, { props: { symbol: 'AAPL' } });
    const submitBtn = screen.getByText('BUY 1 AAPL');
    await fireEvent.click(submitBtn);

    expect(api.placeOrder).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'AAPL',
      side: 'BUY',
      order_type: 'MKT',
      quantity: 1,
      time_in_force: 'DAY',
    }));
  });

  it('shows success message after order placed', async () => {
    vi.mocked(api.placeOrder).mockResolvedValue({ trade: {}, message: 'Order submitted' });

    render(OrderEntry, { props: { symbol: 'AAPL' } });
    await fireEvent.click(screen.getByText('BUY 1 AAPL'));

    // Wait for async resolution
    await vi.waitFor(() => {
      expect(screen.getByText('Order submitted')).toBeInTheDocument();
    });
  });

  it('shows error message on failure', async () => {
    vi.mocked(api.placeOrder).mockRejectedValue(new Error('Connection refused'));

    render(OrderEntry, { props: { symbol: 'AAPL' } });
    await fireEvent.click(screen.getByText('BUY 1 AAPL'));

    await vi.waitFor(() => {
      expect(screen.getByText('Connection refused')).toBeInTheDocument();
    });
  });

  it('disables submit button when quantity is 0', async () => {
    render(OrderEntry, { props: { symbol: 'AAPL' } });
    const qtyInput = screen.getByLabelText('Quantity');
    await fireEvent.input(qtyInput, { target: { value: '0' } });

    // The submit button should be disabled
    const buttons = screen.getAllByRole('button');
    const submitBtn = buttons.find((b) => b.textContent?.includes('AAPL'));
    expect(submitBtn).toBeDisabled();
  });
});
