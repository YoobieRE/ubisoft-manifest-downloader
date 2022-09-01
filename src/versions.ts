import inquirer from 'inquirer';
import { Logger } from 'loglevel';
import fetch from 'node-fetch';

export interface VersionSelectProps {
  log: Logger;
}

export interface ManifestVersion {
  productId: number;
  manifest: string;
  releaseDate?: string;
  digitalDistributionVersion?: number;
  communitySemver?: string;
  communityDescription?: string;
}

export class VersionSelect {
  private L: Logger;

  constructor(props: VersionSelectProps) {
    this.L = props.log;
  }

  public async prompVersionSelect(productId: number): Promise<ManifestVersion> {
    // Use database to get list of known manifest hashes and their colloqial version number or date
    const versionsResp = await fetch(
      `https://raw.githubusercontent.com/YoobieRE/manifest-versions/main/versions/${productId
        .toString()
        .padStart(5, '0')}.json`
    );

    if (!versionsResp.ok) throw new Error(`Could not get versions for game ID ${productId}`);

    const versionsData: ManifestVersion[] = await versionsResp.json();

    this.L.debug('Version data from database:', JSON.stringify(versionsData));

    const versionChoices = versionsData.map((version) => {
      const nameParts = [
        version.releaseDate?.substring(0, 10),
        version.communitySemver,
        version.communityDescription,
      ].filter((part): part is string => Boolean(part));
      const name = `${nameParts.join(' - ')} (${version.manifest})`;
      return {
        name,
        value: version,
      };
    });

    const { version } = await inquirer.prompt<{ version: ManifestVersion }>({
      type: 'list',
      name: 'version',
      message: `Select which version you'd like to download`,
      choices: versionChoices,
    });
    return version;
  }
}
