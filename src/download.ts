/* eslint-disable no-await-in-loop */
import { download, UbisoftDemux, UbisoftFileParser } from 'ubisoft-demux';
import { fileHashToPathChar } from 'ubisoft-demux/dist/src/util';
import { Logger } from 'loglevel';
import FileDownloader from 'nodejs-file-downloader';
import fs from 'fs-extra';
import path from 'path';
import { promises as fsPromises } from 'fs';
import PQueue from 'p-queue';
import { request } from 'undici';
import { decompress as decompressZstd } from 'zstd.ts';
import { ManifestVersion } from './versions';
import { GameInstall } from './install';
import { manifestCachePath } from './cache';

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

  private gameInstall: GameInstall;

  constructor(props: GameDownloaderProps) {
    this.L = props.log;
    this.demux = props.demux;
    this.version = props.version;
    this.gameInstall = new GameInstall({ log: this.L, productId: this.version.productId });
  }

  public async download(): Promise<void> {
    const currentState = await this.gameInstall.getInstallState();
    if (currentState?.manifestSha1 === this.version.manifest) {
      this.L.info('This version is already installed. Cancelling download.');
      return;
    }
    const latestManifest = await this.getVersionManifest();
    let filesToObtain: download.File[];
    if (!currentState) {
      this.L.debug('No existing install detected. Doing a fresh install...');
      filesToObtain = latestManifest.chunks.flatMap((chunk) => chunk.files);
    } else {
      this.L.debug('Detecting which files need updating...');
      const currentManifest = await this.gameInstall.getManifest();
      filesToObtain = latestManifest.chunks
        .flatMap((chunk) =>
          chunk.files.map((file) => {
            const currentChunk = currentManifest.chunks.find((c) => c.id === chunk.id);
            if (!currentChunk) return file;
            const currentFile = currentChunk.files.find((f) => f.name === file.name);
            if (!currentFile) return file;
            const slicesAreSame = file.slices.every(
              (slice, sliceIndex) => Buffer.compare(slice, currentFile.slices[sliceIndex]) === 0
            );
            if (!slicesAreSame) return file;
            return null;
          })
        )
        .filter((f): f is download.File => f !== null);
    }
    const downloaderQueue = new PQueue({ autoStart: false });
    const installPath = await this.gameInstall.getInstallPath();
    const fileDownloadPromises = filesToObtain.map((file) =>
      downloaderQueue.add(async () => {
        const slicePaths = file.slices.map((sliceBin) => {
          const sliceHash = sliceBin.toString('hex').toUpperCase();
          return `slices_v3/${fileHashToPathChar(sliceHash)}/${sliceHash}`;
        });
        const urls = await this.signUrls(slicePaths);
        const fileHook = await fsPromises.open(path.join(installPath, file.name), 'w');
        await fileHook.write(Buffer.alloc(1), undefined, undefined, file.size - 1); // Create empty file
        let sliceOffsetByte = 0;
        // eslint-disable-next-line no-restricted-syntax
        for (const [sliceIndex, sliceUrl] of urls.entries()) {
          const res = await request(sliceUrl);
          const sliceData = file.sliceList[sliceIndex];

          const sliceBin = Buffer.from(await res.body.arrayBuffer());
          const decomSliceBin = await this.decompressSlice(
            latestManifest.compressionMethod,
            sliceBin
          );
          await fileHook.write(decomSliceBin, undefined, undefined, sliceOffsetByte);
          sliceOffsetByte += sliceData.size;
        }
        await fileHook.close();
      })
    );

    downloaderQueue.start();
    await Promise.all(fileDownloadPromises);
  }

  // eslint-disable-next-line class-methods-use-this
  private async decompressSlice(
    compressionMethod: download.CompressionMethod,
    compressedData: Buffer
  ): Promise<Buffer> {
    if (compressionMethod === download.CompressionMethod.CompressionMethod_Zstd) {
      return decompressZstd({ input: compressedData });
    }
    return compressedData;
  }

  private async getVersionManifest(): Promise<download.Manifest> {
    const [manifestUrl] = await this.signUrls([`manifests/${this.version.manifest}.manifest`]);
    const downloader = new FileDownloader({ url: manifestUrl, directory: manifestCachePath });
    const { filePath } = await downloader.download();
    if (!filePath) throw new Error('Could not locate downlaoded manifest');
    const manifestBin = await fs.readFile(filePath);
    const manifestData = this.fileParser.parseDownloadManifest(manifestBin);
    return manifestData;
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
