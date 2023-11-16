import {BaseCommand} from '@adonisjs/core/build/standalone'
import {JobContract} from "App/Services/Jobs/Jobs";
import {AppContainerAliasesEnum} from "App/Enums/AppContainerAliasesEnum";
import {ScrapeNpmRegistryJobParameters} from "App/Jobs/ScrapeNpmRegistryJob";
import Helper from "@ioc:Providers/Helper";
import NpmPackage from "App/Models/NpmPackage";
import Console from "@ioc:Providers/Console";

export default class CheckInstalledPackages extends BaseCommand {
  /**
   * Command name is used to run the command
   */
  public static commandName = 'check:packages'

  /**
   * Command description is displayed in the "help" output
   */
  public static description = ''

  public static settings = {
    /**
     * Set the following value to true, if you want to load the application
     * before running the command. Don't forget to call `node ace generate:manifest`
     * afterwards.
     */
    loadApp: true,

    /**
     * Set the following value to true, if you want this command to keep running until
     * you manually decide to exit the process. Don't forget to call
     * `node ace generate:manifest` afterwards.
     */
    stayAlive: false,
  }

  public async run() {
    const Jobs: JobContract = this.application.container.use(AppContainerAliasesEnum.Jobs);

    await Jobs.waitUntilDone(
      await Jobs.dispatch<ScrapeNpmRegistryJobParameters>(
        "ScrapeNpmRegistryJob",
        {}
      )
    );

    const packages = await NpmPackage.all();
    const packagesAndVersions = packages.map((p) => {
      return {
        name: p.name,
        version: p.lastVersion,
      }
    });

    const packageNames = Helper.loadInstalledPackage();
    const installedPackagesAndVersions = Object.keys(packageNames).map((p) => {
      return {
        name: p,
        version: packageNames[p],
      }
    });

    let status = packagesAndVersions.map((p) => {
      const installedPackage = installedPackagesAndVersions.find((ip) => ip.name === p.name);
      if (!installedPackage || !p.version) {
        return {
          ...p,
          'current version': null,
          status: "not installed",
        }
      }

      return {
        ...p,
        'current version': installedPackage.version,
        status: !installedPackage.version.includes(p.version) ? "outdated" : "up to date",
      };
    });

    status = status.filter((s) => s.status !== "up to date");

    if (status.length) {
      Console.log("The following packages are outdated:");
      Console.table(status);
      return;
    }

    Console.log("All packages are up to date");
  }
}
