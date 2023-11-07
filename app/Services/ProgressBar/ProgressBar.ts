import progress from 'cli-progress';
import colors from "ansi-colors";
import Application from "@ioc:Adonis/Core/Application";

export interface ProgressBarContract {
  addBar(length: number, title?: string, color?: string, index?: number): number;

  next(index?: number, steps?: number): void;

  prev(index?: number, steps?: number): void;

  stop(index?: number): void;

  stopAll(): void;

  forceCurrentStdout(): void;
}

export default class ProgressBar implements ProgressBarContract {
  private multibarService: progress.MultiBar;
  private bars: progress.SingleBar[];
  private stepsStatus: number[];

  constructor() {
    if (Application.environment === "console") {
      this.multibarService = new progress.MultiBar({});
      this.bars = [];
    }
    this.stepsStatus = [];
  }

  forceCurrentStdout(): void {
    this.multibarService.stop();
    this.bars = [];
    const {stdout} = require("node:process");
    this.multibarService = new progress.MultiBar({stream: stdout});
  }

  addBar(length: number, title: string = "Progress", color: string = "cyan", index?: number): number {
    const titleLength = title.length;
    const maxTitleLength = 30;
    let toAdd = Math.ceil(maxTitleLength - titleLength);

    if (toAdd > 0 && toAdd % 2) {
      toAdd++;
    }

    let newTitle = "- ";

    for (let i = 0; i < toAdd; i = i + 2) {
      title = "-" + title + "-";
    }

    newTitle += title + " -";

    if (Application.environment === "console") {
      const bar = this.multibarService.create(
        length,
        0,
        null,
        {format: newTitle + ' |' + colors[color]('{bar}') + '| {percentage}% | ETA: {eta}s | {value}/{total}'}
      );

      if (index !== undefined) {
        this.bars[index] = bar;
      } else {
        this.bars.push(bar);
      }
    }

    if (index !== undefined) {
      this.stepsStatus[index] = 0;
      return index;
    }

    this.stepsStatus.push(0);
    return this.stepsStatus.length - 1;
  }

  next(index: number = 0, steps: number = 1): void {
    this.stepsStatus[index] += steps;

    if (Application.environment === "console") {
      this.bars[index].update(this.stepsStatus[index]);
    }
  }

  prev(index: number = 0, steps: number = 1): void {
    this.stepsStatus[index] -= steps;

    if (Application.environment === "console") {
      this.bars[index].update(this.stepsStatus[index]);
    }
  }

  stop(index: number = 0): void {
    this.stepsStatus.splice(index, 1);

    if (Application.environment === "console") {
      const bar = this.bars.splice(index, 1);
      this.multibarService.remove(bar[0]);
    }
  }

  stopAll(): void {
    this.bars = [];
    this.stepsStatus = [];

    if (Application.environment === "console") {
      this.multibarService.stop();
    }
  }
}
