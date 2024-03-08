import progress from 'cli-progress';
import Application from "@ioc:Adonis/Core/Application";
import colors from "ansi-colors";
import {isMainThread} from "node:worker_threads";
import {EmitEventType} from "App/Services/Socket/SocketTypes";
import {AppContainerAliasesEnum} from 'App/Enums/AppContainerAliasesEnum';
import {
  progressBarChangeTitle,
  progressBarOff,
  progressBarOffAll,
  progressBarOn,
  progressBarSetProgress,
  progressBarUpdate
} from "App/Services/Jobs/JobHelpers";

export interface ProgressBarContract {
  newBar(length: number, title?: string, index?: string, color?: string): Promise<string>;

  increment(index: string, steps?: number): Promise<void>;

  decrement(index: string, steps?: number): Promise<void>;

  finish(index: string): Promise<void>;

  finishAll(): Promise<void>;

  changeTitle(index: string, title: string): Promise<void>;

  setProgress(index: string, progress: number): Promise<void>;

  getAllBarsConfigAndStatus(): {
    id: string | number;
    title: string;
    length: number;
    progress: number;
  }[];
}

export default class ProgressBar implements ProgressBarContract {
  private multibarService: progress.MultiBar;
  private bars: { [p: string | number]: progress.SingleBar };
  private currentLength: { [p: string | number]: number };
  private length: { [p: string | number]: number };
  private barColor: { [p: string | number]: string };
  private titles: { [p: string | number]: string };
  private maxTitleLength: number = 55;
  private eta: { [p: string | number]: number };

  constructor() {
    this.multibarService = new progress.MultiBar({});

    this.bars = {};
    this.currentLength = {};
    this.length = {};
    this.barColor = {};
    this.titles = {};
    this.eta = {};
  }

  private calculateTitle(title: string): string {
    let toAdd = Math.ceil(this.maxTitleLength - title.length);
    if (toAdd > 0 && toAdd % 2) {
      toAdd++;
    }

    let newTitle = "- ";
    for (let i = 0; i < toAdd; i = i + 2) {
      title = "-" + title + "-";
    }
    newTitle += title + " -";

    return newTitle;
  }

  async newBar(length: number, title: string = "Progress", index?: string, color: string = "cyan"): Promise<string> {
    if (!isMainThread) {
      return await progressBarOn(index, length, title);
    }

    const newTitle = this.calculateTitle(title);

    const finalIndex = index ?? require("uuid").v4();

    const bar = this.multibarService.create(
      length,
      0,
      null,
      {format: newTitle + ' |' + colors[color]('{bar}') + '| {percentage}% | ETA: {eta}s | {value}/{total}'}
    );

    if (this.bars[finalIndex]) {
      await this.finish(finalIndex);
    }

    this.bars[finalIndex] = bar;

    this.currentLength[finalIndex] = 0;
    this.barColor[finalIndex] = color;
    this.titles[finalIndex] = newTitle;
    this.length[finalIndex] = length;
    this.eta[finalIndex] = Infinity;

    try {
      await Application.container.use(AppContainerAliasesEnum.Socket).emitToAdmins(
        EmitEventType.PROGRESS_BAR_ON,
        {
          id: finalIndex,
          title: newTitle,
          length: length,
          eta: Infinity,
        }
      );
    } catch (e) {
    }

    return finalIndex;
  }

  async increment(index: string, steps: number = 1): Promise<void> {
    if (!isMainThread) {
      progressBarUpdate(index, steps);
      return;
    }

    this.currentLength[index] += steps;

    this.bars[index].update(this.currentLength[index]);

    // @ts-ignore
    this.eta[index] = this.bars[index].eta.getTime();

    try {
      await Application.container.use(AppContainerAliasesEnum.Socket).emitToAdmins(
        EmitEventType.PROGRESS_BAR_INCREMENT,
        {
          id: index,
          steps: steps,
          eta: this.eta[index]
        }
      );
    } catch (e) {
    }
  }

  async decrement(index: string, steps: number = 1): Promise<void> {
    if (!isMainThread) {
      progressBarUpdate(index, -steps);
      return;
    }

    this.currentLength[index] -= steps;

    this.bars[index].update(this.currentLength[index]);

    // @ts-ignore
    this.eta[index] = this.bars[index].eta.getTime();

    try {
      await Application.container.use(AppContainerAliasesEnum.Socket).emitToAdmins(
        EmitEventType.PROGRESS_BAR_DECREMENT,
        {
          id: index,
          steps: steps,
          eta: this.eta[index],
        }
      );
    } catch (e) {
    }
  }

  async finish(index: string): Promise<void> {
    if (!isMainThread) {
      progressBarOff(index);
      return;
    }

    this.bars[index].stop();

    this.multibarService.remove(this.bars[index]);

    delete this.bars[index];
    delete this.currentLength[index];
    delete this.barColor[index];
    delete this.titles[index];
    delete this.length[index];
    delete this.eta[index];

    try {
      await Application.container.use(AppContainerAliasesEnum.Socket).emitToAdmins(
        EmitEventType.PROGRESS_BAR_OFF,
        {
          id: index,
        }
      );
    } catch (e) {
    }
  }

  async finishAll(): Promise<void> {
    if (!isMainThread) {
      progressBarOffAll();
      return;
    }

    this.multibarService.stop();

    this.bars = {};
    this.currentLength = {};
    this.barColor = {};
    this.titles = {};
    this.length = {};
    this.eta = {};

    try {
      await Application.container.use(AppContainerAliasesEnum.Socket).emitToAdmins(
        EmitEventType.PROGRESS_BAR_OFF_ALL,
        {}
      );
    } catch (e) {
    }
  }

  async changeTitle(index: string, title: string): Promise<void> {
    if (!isMainThread) {
      progressBarChangeTitle(index, title);
      return;
    }

    const newTitle = this.calculateTitle(title);

    // @ts-ignore
    this.bars[index].options.format = newTitle + ' |' + colors[this.barColor[index]]('{bar}') + '| {percentage}% | ETA: {eta}s | {value}/{total}';

    this.titles[index] = newTitle;

    try {
      await Application.container.use(AppContainerAliasesEnum.Socket).emitToAdmins(
        EmitEventType.PROGRESS_BAR_CHANGE_TITLE,
        {
          id: index,
          title: newTitle,
        }
      );
    } catch (e) {
    }
  }

  async setProgress(index: string, progress: number): Promise<void> {
    if (!isMainThread) {
      progressBarSetProgress(index, progress);
      return;
    }

    this.currentLength[index] = progress;

    this.bars[index].update(progress);

    // @ts-ignore
    this.eta[index] = this.bars[index].eta.getTime();

    try {
      await Application.container.use(AppContainerAliasesEnum.Socket).emitToAdmins(
        EmitEventType.PROGRESS_BAR_SET_PROGRESS,
        {
          id: index,
          progress: progress,
          eta: this.eta[index],
        }
      );
    } catch (e) {
    }
  }

  getAllBarsConfigAndStatus(): {
    id: string | number;
    title: string;
    length: number;
    progress: number;
    eta: number;
  }[] {
    const keys = Object.keys(this.currentLength);

    const bars: {
      id: string | number;
      title: string;
      length: number;
      progress: number;
      eta: number;
    }[] = [];

    for (const key of keys) {
      bars.push({
        id: key,
        title: this.titles[key],
        length: this.length[key],
        progress: this.currentLength[key],
        eta: this.eta[key],
      });
    }

    return bars;
  }
}
