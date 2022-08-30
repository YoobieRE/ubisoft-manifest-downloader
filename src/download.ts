import { UbisoftDemux, UbisoftFileParser } from 'ubisoft-demux';
import { Logger } from 'loglevel';
import { ManifestVersion } from '.';

export interface GameDownloaderProps {
  demux: UbisoftDemux;
  version: ManifestVersion;
  log: Logger;
}

export class GameDownloader {
  private L: Logger;

  private demux: UbisoftDemux;

  private version: ManifestVersion;

  private ownershipToken?: string;

  private ownershipTokenExires?: Date;

  private tokenExpiryBufferSec = 5;

  private fileParser = new UbisoftFileParser();

  constructor(props: GameDownloaderProps) {
    this.L = props.log;
    this.demux = props.demux;
    this.version = props.version;
  }

  private async getOwnershipToken(): Promise<string> {
    if (
      this.ownershipToken &&
      this.ownershipTokenExires &&
      Date.now() < this.ownershipTokenExires.getTime() - this.tokenExpiryBufferSec * 1000
    ) {
      return this.ownershipToken;
    }

    const ownershipConnection = await this.demux.openConnection('ownership_service');

    const ownershipTokenResp = await ownershipConnection.request({
      request: {
        requestId: 0,
        ownershipTokenReq: {
          productId: this.version.productId,
        },
      },
    });

    const ownershipToken = ownershipTokenResp.response?.ownershipTokenRsp?.token;

    if (!ownershipToken) {
      throw new Error(`Could not get ownership token for product ID ${this.version.productId}`);
    }

    return ownershipToken;
  }

  private async signUrls(paths: string[]): Promise<string[]> {
    const downloadConnection = await this.demux.openConnection('download_service');

    await downloadConnection.request({
      request: {
        requestId: 0,
        initializeReq: {
          ownershipToken: await this.getOwnershipToken(),
        },
      },
    });

    const urlRequestResp = await downloadConnection.request({
      request: {
        requestId: 0,
        urlReq: {
          urlRequests: [
            {
              productId: this.version.productId,
              relativeFilePath: paths,
            },
          ],
        },
      },
    });

    const signedUrls =
      urlRequestResp.response?.urlRsp?.urlResponses.flatMap((urlResp) =>
        urlResp.downloadUrls.flatMap((dlUrl) => dlUrl.urls)
      ) || [];
    return signedUrls;
  }
}
