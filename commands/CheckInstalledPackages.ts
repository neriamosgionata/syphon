import {args, BaseCommand} from '@adonisjs/core/build/standalone'
import {JobContract} from "App/Services/Jobs/Jobs";
import {AppContainerAliasesEnum} from "App/Enums/AppContainerAliasesEnum";
import {ScrapeNpmRegistryJobParameters} from "App/Jobs/ScrapeNpmRegistryJob";
import Helper from "@ioc:Providers/Helper";
import NpmPackage from "App/Models/NpmPackage";
import Console from "@ioc:Providers/Console";
import {UpdateNpmPackagesJobParameters} from "App/Jobs/UpdateNpmPackagesJob";

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

  @args.string({description: "Update packages?", required: false})
  public updatePackages: string = "n";

  @args.string({description: "To ignore", required: false})
  public toIgnore?: string;

  public async run() {
    const Jobs: JobContract = this.application.container.use(AppContainerAliasesEnum.Jobs);

    await Jobs.waitUntilDone(
      await Jobs.dispatch<ScrapeNpmRegistryJobParameters>(
        "ScrapeNpmRegistryJob",
        {}
      )
    );

    let toIgnore: string[] = this.toIgnore ? this.toIgnore.split(",") : [];

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

    let npmPackages = packagesAndVersions.map((p) => {
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

    npmPackages = npmPackages.filter((s) => s.status !== "up to date");
    npmPackages = npmPackages.filter((s) => !toIgnore.includes(s.name));

    if (!npmPackages.length) {
      Console.log("All packages are up to date");
      return;
    }

    Console.log("The following packages are outdated:");
    Console.table(npmPackages);

    if (this.updatePackages.includes("y")) {
      Console.log("Updating them...");

      await Jobs.waitUntilDone(
        await Jobs.dispatch<UpdateNpmPackagesJobParameters>(
          "UpdateNpmPackagesJob",
          {
            npmPackages: npmPackages as { 'current version': string; status: string; name: string; version: string }[],
          }
        )
      );
    }

  }
}
