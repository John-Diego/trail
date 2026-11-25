// The last step of "npm run build". See third-party.ts for what it writes and why.
import { writeThirdPartyLicenses } from './third-party.ts'

console.log(`dist/THIRD_PARTY_LICENSES.txt  licences of ${writeThirdPartyLicenses()} bundled packages`)
