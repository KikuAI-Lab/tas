import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import * as dotenv from 'dotenv';
import input from 'input';

dotenv.config();

const API_ID = parseInt(process.env.API_ID!, 10);
const API_HASH = process.env.API_HASH!;

async function main() {
    try {
        console.log('Initializing client...');
        const client = new TelegramClient(new StringSession(''), API_ID, API_HASH, {
            connectionRetries: 5,
            useWSS: true
        });

        console.log('Starting client...');
        await client.start({
            phoneNumber: async () => {
                const phone = await input.text('Please enter your phone number: ');
                return phone;
            },
            password: async () => {
                const password = await input.text('Please enter your password: ');
                return password;
            },
            phoneCode: async () => {
                const code = await input.text('Please enter the code you received: ');
                return code;
            },
            onError: (err) => console.error('Error:', err),
        });

        console.log('You should now be connected.');
        const sessionString = client.session.save();
        console.log('\nHere is your SESSION_STRING (save it to your .env file):');
        console.log('\nSESSION_STRING=', sessionString);
        
        await client.disconnect();
        console.log('\nDisconnected successfully.');
    } catch (error) {
        console.error('Fatal error:', error);
        process.exit(1);
    }
}

main().catch(console.error); 