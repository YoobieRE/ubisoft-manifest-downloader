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
import fetch from 'node-fetch';
import { readRememberMeTicket, writeRememberMeTicket } from './cache';

export interface GameSummary {
  gameDetails: ownership_service.OwnedGame;
  configuration: game_configuration.Configuration;
}

export interface ManifestVersion {
  productId: number;
  manifest: string;
  releaseDate?: string;
  digitalDistributionVersion?: number;
  communitySemver?: string;
  communityDescription?: string;
}

async function main() {
  let rememberMeTicket: string | null | undefined = await readRememberMeTicket();
  let ticket: string;

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

  const selectedId = selectedGame.gameDetails.productId;

  // Use database to get list of known manifest hashes and their colloqial version number or date
  const versionsResp = await fetch(
    `https://raw.githubusercontent.com/YoobieRE/manifest-versions/main/versions/${selectedId
      .toString()
      .padStart(5, '0')}.json`
  );

  if (!versionsResp.ok) throw new Error(`Could not get versions for game ID ${selectedId}`);

  const versionsData: ManifestVersion[] = await versionsResp.json();

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

  const ownershipTokenResp = await ownershipConnection.request({
    request: {
      requestId: 0,
      ownershipTokenReq: {
        productId: version.productId,
      },
    },
  });

  const ownershipToken = ownershipTokenResp.response?.ownershipTokenRsp?.token;

  if (!ownershipToken)
    throw new Error(`Could not get ownership token for product ID ${version.productId}`);

  const downloadConnection = await demux.openConnection('download_service');

  await downloadConnection.request({
    request: {
      requestId: 0,
      initializeReq: {
        ownershipToken,
      },
    },
  });

  const relativePaths = [`manifests/${version.manifest}.manifest`];

  const urlRequestResp = await downloadConnection.request({
    request: {
      requestId: 0,
      urlReq: {
        urlRequests: [
          {
            productId: version.productId,
            relativeFilePath: relativePaths,
          },
        ],
      },
    },
  });

  console.log(urlRequestResp);

  // const slicePaths = hashes.map((hash) => `slices_v3/${fileHashToPathChar(hash)}/${hash}`);

  // Download the game from that manifest
}

main();
