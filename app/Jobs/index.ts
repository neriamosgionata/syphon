import DeleteOldJobsJob from "App/Jobs/DeleteOldJobsJob";
import ScrapeNpmRegistryJob from "App/Jobs/ScrapeNpmRegistryJob";
import ScrapeSingleNpmPackageJob from "App/Jobs/ScrapeSingleNpmPackageJob";
import UpdateNpmPackagesJob from "App/Jobs/UpdateNpmPackagesJob";

import AnalyzeNewsletterForTickerJob from "App/Jobs/AnalyzeNewsletterForTickerJob";
import DeleteAllJobsJob from "App/Jobs/DeleteAllJobsJob";
import ScrapeGoogleNewsJob from "App/Jobs/ScrapeGoogleNewsJob";
import ScrapeNewsArticleJob from "App/Jobs/ScrapeNewsArticleJob";
import ScrapeYahooFinanceForTickersJob from "App/Jobs/ScrapeYahooFinanceForTickersJob";

export const JobList = {
  AnalyzeNewsletterForTickerJob,
  DeleteAllJobsJob,
  DeleteOldJobsJob,
  ScrapeGoogleNewsJob,
  ScrapeNewsArticleJob,
  ScrapeNpmRegistryJob,
  ScrapeSingleNpmPackageJob,
  ScrapeYahooFinanceForTickersJob,
  UpdateNpmPackagesJob,
};

export const JobListForFrontend = {
  "AnalyzeNewsletterForTickerJob": {name: "AnalyzeNewsletterForTickerJob", params: {}},
  "DeleteAllJobsJob": {name: "DeleteAllJobsJob", params: {}},
  "DeleteOldJobsJob": {name: "DeleteOldJobsJob", params: {}},
  "ScrapeGoogleNewsJob": {name: "ScrapeGoogleNewsJob", params: {}},
  "ScrapeNewsArticleJob": {name: "ScrapeNewsArticleJob", params: {}},
  "ScrapeNpmRegistryJob": {name: "ScrapeNpmRegistryJob", params: {}},
  "ScrapeSingleNpmPackageJob": {name: "ScrapeSingleNpmPackageJob", params: {}},
  "ScrapeYahooFinanceForTickersJob": {name: "ScrapeYahooFinanceForTickersJob", params: {}},
  "UpdateNpmPackagesJob": {name: "UpdateNpmPackagesJob", params: {}},
}
