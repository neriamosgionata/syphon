export default interface PackageJson {
  name: string;
  version: string;
  description: string;
  private: boolean;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies?: Record<string, string>;
}
