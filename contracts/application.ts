import '@ioc:Adonis/Core/Application';
import {EnvContract} from '@ioc:Adonis/Core/Env';
import * as Helpers from '@ioc:Adonis/Core/Helpers';
import {ConfigContract} from '@ioc:Adonis/Core/Config';
import {LoggerContract as DefaultLogger} from '@ioc:Adonis/Core/Logger';
import {ProfilerContract} from '@ioc:Adonis/Core/Profiler';
import {AppContainerAliasesEnum} from "App/Enums/AppContainerAliasesEnum";
import {LoggerContract} from "App/Services/Logger/Logger";
import {MongoContract} from "App/Services/Mongo/Mongo";
import {JobContract} from "App/Services/Jobs/Jobs";
import {ScraperContract} from "App/Services/Scraper/Scraper";
import {ProgressBarContract} from "App/Services/ProgressBar/ProgressBar";
import {HelperContract} from "App/Services/Helper/Helper";
import {StringCleanerContract} from "App/Services/StringCleaner/StringCleaner";
import {ConsoleContract} from "App/Services/Console/Console";
import {CurrecyContract} from "App/Services/Currency/CurrencyService";
import {SocketContract} from "App/Services/Socket/SocketService";
import {IocContract} from '@adonisjs/fold';
import {FinanceContract} from "App/Services/Finance/Finance";
import {ChartContract} from "App/Services/Charts/Charts";
import {NewsletterContract} from "App/Services/Newsletter/Newsletter";
import {FiltersContract} from "App/Services/Filters/Filters";
import {ANNContract} from "App/Services/ANN/ANN";

declare module '@ioc:Adonis/Core/Application' {

  export interface ContainerBindings {
    "Adonis/Core/Application": ApplicationContract;
    "Adonis/Core/Profiler": ProfilerContract;
    "Adonis/Core/Logger": DefaultLogger;
    "Adonis/Core/Config": ConfigContract;
    "Adonis/Core/Env": EnvContract;
    "Adonis/Core/Helpers": typeof Helpers;
    [AppContainerAliasesEnum.Logger]: LoggerContract;
    [AppContainerAliasesEnum.Mongo]: MongoContract;
    [AppContainerAliasesEnum.Jobs]: JobContract;
    [AppContainerAliasesEnum.Scraper]: ScraperContract;
    [AppContainerAliasesEnum.ProgressBar]: ProgressBarContract;
    [AppContainerAliasesEnum.Helper]: HelperContract;
    [AppContainerAliasesEnum.StringCleaner]: StringCleanerContract;
    [AppContainerAliasesEnum.Console]: ConsoleContract;
    [AppContainerAliasesEnum.Currency]: CurrecyContract;
    [AppContainerAliasesEnum.Finance]: FinanceContract;
    [AppContainerAliasesEnum.Charts]: ChartContract;
    [AppContainerAliasesEnum.Profiler]: ProfilerContract;
    [AppContainerAliasesEnum.Newsletter]: NewsletterContract;
    [AppContainerAliasesEnum.Filters]: FiltersContract;
    [AppContainerAliasesEnum.ANN]: ANNContract;
    [AppContainerAliasesEnum.Socket]: SocketContract;
  }

  export interface ApplicationContract {
    container: IocContract<ContainerBindings>;
  }
}
