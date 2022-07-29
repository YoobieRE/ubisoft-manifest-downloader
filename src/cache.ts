import fs from 'fs-extra';
import path from 'path';

const cacheLocation = '~/ubisoft-manifest-downloader';
const rememberMeTicketFile = 'remember-me-ticket.txt';

export async function writeRememberMeTicket(token: string) {
  await fs.writeFile(path.resolve(cacheLocation, rememberMeTicketFile), token, 'utf-8');
}

export async function readRememberMeTicket(): Promise<string | undefined> {
  try {
    return fs.readFile(path.resolve(cacheLocation, rememberMeTicketFile), 'utf-8');
  } catch (err) {
    // TODO: catch only file not found
    return undefined;
  }
}
