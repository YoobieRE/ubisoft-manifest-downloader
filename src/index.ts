#!/usr/bin/env node
/* eslint-disable camelcase */

import inquirer from 'inquirer';
import yaml from 'yaml';
import {
  CreateSessionSuccessResponse,
  UbiServicesApi,
  UbisoftDemux,
  game_configuration,
} from 'ubisoft-demux';
import { readRememberMeTicket, writeRememberMeTicket } from './cache';

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

  const fullGames = ownedGames.map((game) => {
    const configuration: game_configuration.Configuration = yaml.parse(game.configuration, {
      uniqueKeys: false,
    });
    return { game, configuration };
  });

  const downloadableGames = fullGames
    .filter((game) => game.game.latestManifest)
    .map((game) => ({
      name: game.configuration.root.name as string,
      value: game.game.productId,
    }));

  const gameResp = await inquirer.prompt({
    type: 'list',
    name: 'game',
    message: `Select which game you'd like to download`,
    choices: downloadableGames,
  });

  // Use database to get list of known manifest hashes and their colloqial version number or date

  const versionResp = await inquirer.prompt({
    type: 'list',
    name: 'version',
    message: `Select which version you'd like to download`,
  });

  // Download the game from that manifest
}

main();
