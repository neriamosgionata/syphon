import TickerChart from "App/Models/TickerChart";

export interface ChartContract {
  buildLineChart(ticker: string, interval: string, fromDate?: string, toDate?: string): Promise<any>;
}

export default class Charts implements ChartContract {
  async buildLineChart(
    ticker: string,
    interval: string,
    fromDate?: string,
    toDate?: string
  ) {
    const tickerCharts = await TickerChart.getTickerChart(ticker, interval, fromDate, toDate);

    const labels = tickerCharts.map((tickerChart) => tickerChart.date);
    const data = tickerCharts.map((tickerChart) => tickerChart.close);

    return {
      labels,
      datasets: [
        {
          label: ticker,
          data
        }
      ]
    };
  }
}
