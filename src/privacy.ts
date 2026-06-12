const PASSCODE_STORAGE_KEY = 'murmur.passcode.v1';
const BIOMETRIC_STORAGE_KEY = 'murmur.biometric.v1';
const PBKDF2_ITERATIONS = 210_000;

interface PasscodeRecord {
  salt: string;
  hash: string;
  iterations: number;
  createdAt: string;
}

interface BiometricRecord {
  credentialId: string;
  createdAt: string;
}

export interface PrivacyStatus {
  passcodeEnabled: boolean;
  biometricEnabled: boolean;
  biometricAvailable: boolean;
}

function getCrypto(): Crypto {
  if (!window.crypto?.subtle) {
    throw new Error('Secure browser crypto is not available.');
  }

  return window.crypto;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');

  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(
    base64.length + ((4 - (base64.length % 4)) % 4),
    '=',
  );

  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  getCrypto().getRandomValues(bytes);
  return bytes;
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return result === 0;
}

async function hashPasscode(
  passcode: string,
  salt: Uint8Array,
  iterations: number,
): Promise<string> {
  const crypto = getCrypto();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passcode),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt,
      iterations,
    },
    keyMaterial,
    256,
  );

  return bytesToBase64Url(new Uint8Array(derivedBits));
}

function getPasscodeRecord(): PasscodeRecord | null {
  const storedRecord = localStorage.getItem(PASSCODE_STORAGE_KEY);

  return storedRecord ? (JSON.parse(storedRecord) as PasscodeRecord) : null;
}

function getBiometricRecord(): BiometricRecord | null {
  const storedRecord = localStorage.getItem(BIOMETRIC_STORAGE_KEY);

  return storedRecord ? (JSON.parse(storedRecord) as BiometricRecord) : null;
}

export async function getPrivacyStatus(): Promise<PrivacyStatus> {
  return {
    passcodeEnabled: Boolean(getPasscodeRecord()),
    biometricEnabled: Boolean(getBiometricRecord()),
    biometricAvailable: await isBiometricAvailable(),
  };
}

export async function setPasscode(passcode: string): Promise<void> {
  if (passcode.trim().length < 4) {
    throw new Error('Use at least 4 characters for your passcode.');
  }

  const salt = randomBytes(16);
  const record: PasscodeRecord = {
    salt: bytesToBase64Url(salt),
    hash: await hashPasscode(passcode, salt, PBKDF2_ITERATIONS),
    iterations: PBKDF2_ITERATIONS,
    createdAt: new Date().toISOString(),
  };

  localStorage.setItem(PASSCODE_STORAGE_KEY, JSON.stringify(record));
}

export async function verifyPasscode(passcode: string): Promise<boolean> {
  const record = getPasscodeRecord();

  if (!record) {
    return true;
  }

  const hash = await hashPasscode(
    passcode,
    base64UrlToBytes(record.salt),
    record.iterations,
  );

  return timingSafeEqual(hash, record.hash);
}

export function clearPasscode(): void {
  localStorage.removeItem(PASSCODE_STORAGE_KEY);
}

export async function isBiometricAvailable(): Promise<boolean> {
  if (!window.PublicKeyCredential) {
    return false;
  }

  return PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
}

export async function registerBiometric(): Promise<void> {
  if (!(await isBiometricAvailable())) {
    throw new Error('Biometric unlock is not available on this device.');
  }

  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: randomBytes(32),
      rp: {
        name: 'Murmur',
      },
      user: {
        id: randomBytes(16),
        name: 'murmur-local-user',
        displayName: 'Murmur user',
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'discouraged',
        userVerification: 'required',
      },
      attestation: 'none',
      timeout: 60_000,
    },
  });

  if (!credential || !('rawId' in credential)) {
    throw new Error('Biometric setup was canceled.');
  }

  const record: BiometricRecord = {
    credentialId: bytesToBase64Url(new Uint8Array(credential.rawId)),
    createdAt: new Date().toISOString(),
  };

  localStorage.setItem(BIOMETRIC_STORAGE_KEY, JSON.stringify(record));
}

export async function verifyBiometric(): Promise<boolean> {
  const record = getBiometricRecord();

  if (!record) {
    return false;
  }

  const credential = await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32),
      allowCredentials: [
        {
          id: base64UrlToBytes(record.credentialId),
          type: 'public-key',
          transports: ['internal'],
        },
      ],
      userVerification: 'required',
      timeout: 60_000,
    },
  });

  return Boolean(credential);
}

export function clearBiometric(): void {
  localStorage.removeItem(BIOMETRIC_STORAGE_KEY);
}
