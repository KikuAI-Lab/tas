declare module 'input' {
    interface Input {
        text(prompt: string): Promise<string>;
        select(prompt: string, choices: string[]): Promise<string>;
        confirm(prompt: string): Promise<boolean>;
        password(prompt: string): Promise<string>;
    }
    const input: Input;
    export default input;
}

declare module 'telegram' {
    interface TelegramClientParams {
        connectionRetries?: number;
        useWSS?: boolean;
        timeout?: number;
        requestRetries?: number;
        connection?: any;
        useIPV6?: boolean;
        proxy?: any;
        retryDelay?: number;
    }

    interface UserAuthParams {
        phoneNumber: () => Promise<string> | string;
        password: () => Promise<string> | string;
        phoneCode: () => Promise<string> | string;
        onError: (err: Error) => void;
    }

    export class TelegramClient {
        constructor(session: StringSession, apiId: number, apiHash: string, params?: TelegramClientParams);
        session: StringSession;
        start(params: UserAuthParams): Promise<void>;
        connect(): Promise<void>;
        disconnect(): Promise<void>;
    }
}

declare module 'telegram/sessions' {
    export class StringSession {
        constructor(session?: string);
        save(): string;
        encode(value: Buffer): string;
        decode(value: string): Buffer;
    }
} 