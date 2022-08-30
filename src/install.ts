import { UbisoftFileParser } from 'ubisoft-demux';
import { Logger } from 'loglevel';
import inquirer from 'inquirer';
import registry from 'native-reg';
import fs from 'fs-extra';
import { promises as fsPromises } from 'fs';
import path from 'path';
import EventEmitter from 'events';
// eslint-disable-next-line import/no-extraneous-dependencies
import TypedEmitter from 'typed-emitter';
import PQueue from 'p-queue';
import crypto from 'crypto';

export type GameInstallEvents = {
  verifyProgress: (percent: number) => void;
};

export interface GameInstallProps {
  productId: number;
  log: Logger;
}

export interface VerifyResult {
  badFiles: string[];
  goodFiles: string[];
}

const MANIFEST_FILENAME = 'uplay_install.manifest';

const STATE_FILENAME = 'uplay_install.state';

export class GameInstall extends (EventEmitter as new () => TypedEmitter<GameInstallEvents>) {
  private L: Logger;

  private productId: number;

  private fileParser = new UbisoftFileParser();

  constructor(props: GameInstallProps) {
    super();
    this.L = props.log;
    this.productId = props.productId;
  }

  private async getInstallPath(): Promise<string> {
    let installLocation;
    try {
      // HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs\5595\InstallDir
      const installPath = registry.getValue(
        registry.HKLM,
        `SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs\\${this.productId}`,
        `InstallDir`,
        registry.GetValueFlags.RT_REG_SZ
      ) as string;
      if (!installPath) throw new Error('Install location key returned null');
      installLocation = installPath;
    } catch (err) {
      this.L.debug(err);
      this.L.info('Could not locate existing game install location.');
      const { location } = await inquirer.prompt<{ location: string }>({
        type: 'input',
        name: 'location',
        message: `Where would you like to install the game?`,
      });
      installLocation = location;
    }
    const resolvedLocation = path.resolve(installLocation);

    if (!(await fs.pathExists(resolvedLocation))) {
      this.L.debug('Creating install directory:', resolvedLocation);
      await fs.mkdirp(resolvedLocation);
    }
    await Promise.all([
      fs.access(resolvedLocation, fs.constants.W_OK),
      fs.access(resolvedLocation, fs.constants.O_DIRECTORY),
    ]);

    return resolvedLocation;
  }

  public async verify(): Promise<VerifyResult> {
    const installPath = await this.getInstallPath();
    const manifestBin = await fs.readFile(path.join(installPath, MANIFEST_FILENAME));
    const manifestData = this.fileParser.parseDownloadManifest(manifestBin);
    const verifyFileQueue = new PQueue({ autoStart: false });

    const files = manifestData.chunks.flatMap((chunk) =>
      chunk.files.map((file) => {
        let currentSliceOffset = 0;
        const sliceInfos = file.sliceList.map((slice) => {
          const sliceInfo = {
            size: slice.size,
            sliceOffset: currentSliceOffset,
            downloadSha1: slice.downloadSha1,
          };
          currentSliceOffset += slice.size;
          return sliceInfo;
        });
        return {
          name: file.name,
          chunkType: chunk.type,
          slices: sliceInfos,
        };
      })
    );

    this.L.trace('All the files:', JSON.stringify(files));

    const badFiles: string[] = [];
    const goodFiles: string[] = [];

    const fileVerifyPromises = files.map((file) =>
      verifyFileQueue.add(async () => {
        const sliceFile = await fsPromises.open(path.join(installPath, file.name));
        // eslint-disable-next-line no-restricted-syntax
        for (const slice of file.slices) {
          const sliceBuffer = Buffer.alloc(slice.size);
          // eslint-disable-next-line no-await-in-loop
          await sliceFile.read({ buffer: sliceBuffer, position: slice.sliceOffset });
          const hashSum = crypto.createHash('sha1');
          hashSum.update(sliceBuffer);
          if (Buffer.compare(slice.downloadSha1, hashSum.digest()) !== 0) {
            this.L.info('Bad file:', file.name);
            badFiles.push(file.name);
            return;
          }
        }
        goodFiles.push(file.name);
      })
    );

    const totalSlices = verifyFileQueue.size;
    verifyFileQueue.on('active', () => {
      this.emit('verifyProgress', verifyFileQueue.pending / totalSlices);
    });
    verifyFileQueue.start();
    await Promise.all(fileVerifyPromises);
    return { badFiles, goodFiles };
  }
}