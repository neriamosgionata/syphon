import DeleteOldJobsJob from "App/Jobs/DeleteOldJobsJob";
import ScrapeNpmRegistryJob from "App/Jobs/ScrapeNpmRegistryJob";
import ScrapeSingleNpmPackageJob from "App/Jobs/ScrapeSingleNpmPackageJob";
import UpdateNpmPackagesJob from "App/Jobs/UpdateNpmPackagesJob";

import AnalyzeNewsletterByTickerJob from "App/Jobs/AnalyzeNewsletterByTickerJob";
import DeleteAllJobsJob from "App/Jobs/DeleteAllJobsJob";
import ScrapeYahooFinanceForTickersJob from "App/Jobs/ScrapeYahooFinanceForTickersJob";
import ScrapeNewsArticleJob from "App/Jobs/ScrapeNewsArticleJob";

export const JobList = {
  ScrapeNewsArticleJob,
  AnalyzeNewsletterByTickerJob,
  DeleteAllJobsJob,
  DeleteOldJobsJob,
  ScrapeNpmRegistryJob,
  ScrapeSingleNpmPackageJob,
  ScrapeYahooFinanceForTickersJob,
  UpdateNpmPackagesJob,
};

export const JobListForFrontend = {
  "ScrapeNewsArticleJob": {name: "ScrapeNewsArticleJob", params: {}},
  "AnalyzeNewsletterForTickerJob": {name: "AnalyzeNewsletterForTickerJob", params: {}},
  "DeleteAllJobsJob": {name: "DeleteAllJobsJob", params: {}},
  "DeleteOldJobsJob": {name: "DeleteOldJobsJob", params: {}},
  "ScrapeGoogleNewsJob": {name: "ScrapeGoogleNewsJob", params: {}},
  "ScrapeSingleNpmPackageJob": {name: "ScrapeSingleNpmPackageJob", params: {}},
  "ScrapeYahooFinanceForTickersJob": {name: "ScrapeYahooFinanceForTickersJob", params: {}},
  "UpdateNpmPackagesJob": {name: "UpdateNpmPackagesJob", params: {}},
}
