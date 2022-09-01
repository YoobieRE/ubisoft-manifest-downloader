#!/usr/bin/env node
/* eslint-disable camelcase */

import inquirer from 'inquirer';
import yaml from 'yaml';
import {
  CreateSessionSuccessResponse,
  UbiServicesApi,
  UbisoftDemux,
  game_configuration,
  ownership_service,
} from 'ubisoft-demux';
import log from 'loglevel';
import { readRememberMeTicket, writeRememberMeTicket } from './cache';
import { VersionSelect } from './versions';
import { GameDownloader } from './download';
import { GameInstall } from './install';

export interface GameSummary {
  gameDetails: ownership_service.OwnedGame;
  configuration: game_configuration.Configuration;
}

async function main() {
  let rememberMeTicket: string | null | undefined = await readRememberMeTicket();
  let ticket: string;

  log.setLevel('info');

  const ubiServices = new UbiServicesApi();
  if (rememberMeTicket) {
    // obtain new ticket, update rememberMeTicket
    const loginResp = await ubiServices.loginRememberMe(rememberMeTicket);
    ticket = loginResp.ticket;
    rememberMeTicket = loginResp.rememberMeTicket;
  } else {
    console.log(
      `We havent figured out how to hook into your local Ubisoft credentials yet, so you'll need to login for this to work.`
    );
    console.log(`Your email and password will not be stored locally, only a login refresh token.`);

    const emailResp = await inquirer.prompt<{ email: string }>({
      type: 'input',
      name: 'email',
      message: `Email:`,
    });

    const passwordResp = await inquirer.prompt<{ password: string }>({
      type: 'password',
      name: 'password',
      message: `Password:`,
    });

    // Attempt login, check if 2fa is required
    const loginResp = await ubiServices.login(emailResp.email, passwordResp.password);

    if (loginResp.twoFactorAuthenticationTicket) {
      const mfaResp = await inquirer.prompt<{ mfaCode: string }>({
        type: 'input',
        name: 'mfaCode',
        message: `Enter the two-factor code from your: ${loginResp.codeGenerationPreference}`,
      });
      const mfaLoginResp = await ubiServices.login2fa(
        loginResp.twoFactorAuthenticationTicket,
        mfaResp.mfaCode
      );
      ticket = mfaLoginResp.ticket;
      rememberMeTicket = mfaLoginResp.rememberMeTicket;
    } else {
      ticket = (loginResp as CreateSessionSuccessResponse).ticket;
      rememberMeTicket = (loginResp as CreateSessionSuccessResponse).rememberMeTicket;
    }
  }
  // Cache rememberMeTicket
  if (rememberMeTicket) await writeRememberMeTicket(rememberMeTicket);

  // Use demux API to get list of owned games
  const demux = new UbisoftDemux();
  await demux.basicRequest({
    authenticateReq: {
      clientId: 'uplay_pc',
      sendKeepAlive: false,
      token: {
        ubiTicket: ticket,
      },
    },
  });

  const ownershipConnection = await demux.openConnection('ownership_service');

  const ownershipResp = await ownershipConnection.request({
    request: {
      requestId: 1,
      initializeReq: {
        getAssociations: true,
        protoVersion: 7,
        useStaging: false,
      },
    },
  });

  const ownedGames = ownershipResp.response?.initializeRsp?.ownedGames?.ownedGames;
  if (!ownedGames || !ownedGames.length) throw new Error('This account does not own any games');

  const fullGames: GameSummary[] = ownedGames.map((gameDetails) => {
    const configuration: game_configuration.Configuration = yaml.parse(gameDetails.configuration, {
      uniqueKeys: false,
    });
    return { gameDetails, configuration };
  });

  const downloadableGames = fullGames
    .filter((gameSummary) => gameSummary.gameDetails.latestManifest)
    .map((gameSummary) => ({
      name:
        gameSummary.configuration?.root?.name || `unknown (${gameSummary.gameDetails.productId})`,
      value: gameSummary,
    }));

  const { selectedGame } = await inquirer.prompt<{ selectedGame: GameSummary }>({
    type: 'list',
    name: 'selectedGame',
    message: `Select which game you'd like to download`,
    choices: downloadableGames,
  });

  const { productId } = selectedGame.gameDetails;

  const { actionChoice } = await inquirer.prompt<{ actionChoice: 'Download' | 'Verify' }>({
    type: 'list',
    name: 'actionChoice',
    message: `Would you like to download or verify the game files?`,
    choices: ['Download', 'Verify'],
  });

  if (actionChoice === 'Verify') {
    const gameInstall = new GameInstall({ log, productId });
    gameInstall.on('verifyProgress', (percent) => log.info('Progress:', percent.toFixed(2)));
    const verifyResult = await gameInstall.verify();
    log.info(verifyResult);
    process.exit();
  }

  const versionSelect = new VersionSelect({ log });

  const version = await versionSelect.prompVersionSelect(productId);

  const gameDownloader = new GameDownloader({ log, demux, version });
  // const slicePaths = hashes.map((hash) => `slices_v3/${fileHashToPathChar(hash)}/${hash}`);

  // Download the game from that manifest
}

main();
