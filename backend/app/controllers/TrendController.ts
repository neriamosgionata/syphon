import TrendEvalService from '#services/TrendEvalService'

// Read-only trend evaluation surface: state, tripwire, recent snapshots.

export default class TrendController {
  public async status(): Promise<Record<string, any>> {
    return TrendEvalService.status()
  }
}
