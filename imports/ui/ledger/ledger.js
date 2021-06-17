/* eslint-disable camelcase */
// https://github.com/zondax/cosmos-delegation-js/
// https://github.com/cosmos/ledger-cosmos-js/blob/master/src/index.js
import 'babel-polyfill';
import { Meteor } from 'meteor/meteor';
import TransportWebUSB from "@ledgerhq/hw-transport-webusb";
import BluetoothTransport from "@ledgerhq/hw-transport-web-ble";
import CosmosApp from "ledger-cosmos-js"
import { signatureImport } from "secp256k1"
import semver from "semver"
import bech32 from "bech32";
import sha256 from "crypto-js/sha256"
import ripemd160 from "crypto-js/ripemd160"
import CryptoJS from "crypto-js"
import {
    AccountData,
    AminoSignResponse,
    encodeSecp256k1Signature,
    makeCosmoshubPath,
    OfflineAminoSigner,
    serializeSignDoc,
    StdSignDoc,
    LedgerSigner
} from "@cosmjs/amino";
import crypto from "crypto";
import { fromBase64, toHex, toUtf8, fromHex } from "@cosmjs/encoding";
import { SignMode } from "@cosmjs/stargate/build/codec/cosmos/tx/signing/v1beta1/signing";
import message from "@forbole/cosmos-protobuf-js"
import { encodeSecp256k1Pubkey, makeSignDoc as makeSignDocAmino } from "@cosmjs/amino";

// import { TxRaw, AuthInfo, TxBody, SignDoc } from "@cosmjs/stargate/build/codec/cosmos/tx/v1beta1/tx";
import secp256k1 from 'secp256k1';
import { sha256 as sha256JS } from 'js-sha256';
import { TxRaw, AuthInfo, TxBody, SignDoc } from "@cosmjs/proto-signing/build/codec/cosmos/tx/v1beta1/tx";
import {
    assertIsBroadcastTxSuccess as assertIsBroadcastTxSuccessStargate,
    SigningStargateClient,
} from "@cosmjs/stargate";
import {
    EncodeObject,
    encodePubkey,
    isOfflineDirectSigner,
    makeAuthInfoBytes,
    makeSignDoc,
    OfflineSigner,
    Registry,
    TxBodyEncodeObject,
} from "@cosmjs/proto-signing";
import { MsgDelegate } from "@cosmjs/stargate/build/codec/cosmos/staking/v1beta1/tx";
import  { Msg, MsgSend }  from "@cosmjs/stargate/build/codec/cosmos/bank/v1beta1/tx";

// TODO: discuss TIMEOUT value
const INTERACTION_TIMEOUT = 10000
const REQUIRED_COSMOS_APP_VERSION = Meteor.settings.public.ledger.ledgerAppVersion || "2.16.0";
const DEFAULT_DENOM = Meteor.settings.public.bondDenom || 'uatom';
export const DEFAULT_GAS_PRICE = parseFloat(Meteor.settings.public.ledger.gasPrice) || 0.025;
export const DEFAULT_MEMO = 'Sent via Big Dipper'

/*
HD wallet derivation path (BIP44)
DerivationPath{44, 118, account, 0, index}
*/

const COINTYPE = Meteor.settings.public.ledger.coinType || 118;

const BECH32PREFIX = Meteor.settings.public.bech32PrefixAccAddr

function bech32ify(address, prefix) {
    const words = bech32.toWords(address)
    return bech32.encode(prefix, words)
}

export const toPubKey = (address) => {
    return bech32.decode(Meteor.settings.public.bech32PrefixAccAddr, address);
}

function createCosmosAddress(publicKey) {
    const message = CryptoJS.enc.Hex.parse(publicKey.toString(`hex`))
    const hash = ripemd160(sha256(message)).toString()
    const address = Buffer.from(hash, `hex`)
    const cosmosAddress = bech32ify(address, Meteor.settings.public.bech32PrefixAccAddr)
    return cosmosAddress
}

export class Ledger {
    constructor({ testModeAllowed }) {
        this.testModeAllowed = testModeAllowed
    }

    getHDPath() {
        let addressIndex = localStorage.getItem(ADDRESSINDEX)
        let HDPATH = [44, COINTYPE, parseInt(addressIndex), 0, 0];
        return HDPATH
    }

    async getLedgerAddresses(accountNumber, transportBLE) {
        await this.connect(INTERACTION_TIMEOUT, transportBLE)
        let hdpaths = await this.cosmosApp?.publicKey([44, COINTYPE, accountNumber, 0, 0])
        let pubKey = hdpaths?.compressed_pk
        return { pubKey, address: createCosmosAddress(pubKey) }
    }

    // test connection and compatibility
    async testDevice() {
        // poll device with low timeout to check if the device is connected
        const secondsTimeout = 3 // a lower value always timeouts
        await this.connect(secondsTimeout, false)
    }
    async isSendingData() {
        // check if the device is connected or on screensaver mode
        const response = await this.cosmosApp.publicKey(this.getHDPath())
        this.checkLedgerErrors(response, {
            timeoutMessag: "Could not find a connected and unlocked Ledger device"
        })
    }
    async isReady(transportBLE) {
    // check if the version is supported
        const version = await this.getCosmosAppVersion(transportBLE)

        if (!semver.gte(version, REQUIRED_COSMOS_APP_VERSION)) {
            const msg = `Outdated version: Please update Ledger Cosmos App to the latest version.`
            throw new Error(msg)
        }

        // throws if not open
        await this.isCosmosAppOpen(transportBLE)
    }
    // connects to the device and checks for compatibility
    async connect(timeout = INTERACTION_TIMEOUT, transportBLE) {
        // assume well connection if connected once
        if (this.cosmosApp) return
        let transport;
        if(transportBLE === true || transportBLE === 'true'){
            transport = await BluetoothTransport.create(timeout)
        }
        else{
            transport= await TransportWebUSB.create(timeout)
        }
        const cosmosLedgerApp = new CosmosApp(transport)

        this.cosmosApp = cosmosLedgerApp

        await this.isSendingData()
        await this.isReady(transportBLE)
    }

    async getDevice(){
        return new Promise((resolve, reject) => {
            const subscription = BluetoothTransport.listen({
                next(event) {
                    if (event.type === 'add') {
                        subscription.unsubscribe();
                        resolve(event.descriptor);
                    }
                },
                error(error) {
                    reject(error);
                },
                complete() {
                }
            });
        });
    }
    async getCosmosAppVersion(transportBLE) {
        await this.connect(INTERACTION_TIMEOUT, transportBLE)

        const response = await this.cosmosApp.getVersion()
        this.checkLedgerErrors(response)
        const { major, minor, patch, test_mode } = response
        checkAppMode(this.testModeAllowed, test_mode)
        const version = versionString({ major, minor, patch })

        return version
    }
    async isCosmosAppOpen(transportBLE) {
        await this.connect(INTERACTION_TIMEOUT, transportBLE)

        const response = await this.cosmosApp.appInfo()
        this.checkLedgerErrors(response)
        const { appName } = response

        if (appName.toLowerCase() !== Meteor.settings.public.ledger.appName.toLowerCase()) {
            throw new Error(`Close ${appName} and open the ${Meteor.settings.public.ledger.appName} app`)
        }
    }
    async getPubKey(transportBLE) {
        await this.connect(INTERACTION_TIMEOUT, transportBLE)

        const response = await this.cosmosApp.publicKey(this.getHDPath())
        this.checkLedgerErrors(response)
        return response.compressed_pk
    }
    async getCosmosAddress(transportBLE) {
        await this.connect(INTERACTION_TIMEOUT, transportBLE)

        const pubKey = await this.getPubKey(this.cosmosApp)
        return {pubKey, address:createCosmosAddress(pubKey)}
    }
    async confirmLedgerAddress(transportBLE) {
        await this.connect(INTERACTION_TIMEOUT, transportBLE)
        const cosmosAppVersion = await this.getCosmosAppVersion()

        if (semver.lt(cosmosAppVersion, REQUIRED_COSMOS_APP_VERSION)) {
            // we can't check the address on an old cosmos app
            return
        }

        const response = await this.cosmosApp.getAddressAndPubKey(
            this.getHDPath(),
            BECH32PREFIX,
        )
        this.checkLedgerErrors(response, {
            rejectionMessage: "Displayed address was rejected"
        })
    }

    async sign(signMessage, txBody, txContext, address, transportBLE) {
        await this.connect(INTERACTION_TIMEOUT, transportBLE)

        let serializeMessage = toUtf8(signMessage)
  
        const bodyB = TxBody.fromPartial(txBody?.body)
        const bodyBytes = TxBody.encode(bodyB).finish();
        console.log(bodyBytes)
        let authI = AuthInfo.fromPartial(txBody.auth_info)
        const authInfoBytes = AuthInfo.encode(authI).finish();
        console.log(authInfoBytes)

        const signDoc = {
            body_bytes: bodyBytes,
            auth_info_bytes: authInfoBytes,
            chain_id: txContext.chainId,
            account_number: Number(txContext.accountNumber)
        };
        let signD = SignDoc.fromPartial(signDoc)
        const signDocEncode = SignDoc.encode(signD).finish()
        // const hash = crypto.createHash("sha256").update(signDocEncode).digest();

        const signature = await this.cosmosApp.sign(this.getHDPath(), serializeMessage)
        const txRaw = {
            body_bytes: bodyBytes,
            auth_info_bytes: authInfoBytes,
            signatures: [Buffer.from(signature.signature)]
        };

        let txraw = TxRaw.fromPartial(txRaw)
        let txRawEncoded = TxRaw.encode(txraw).finish()
        let parsedSignature = signatureImport(signature.signature)
        let pubKey = await this.getPubKey(transportBLE)
        let encodeUserPubkey = encodePubkey(encodeSecp256k1Pubkey(pubKey));
        let txSignature = encodeSecp256k1Signature(pubKey, new Uint8Array(parsedSignature))
        console.log(txSignature)
        return txSignature

        
    }

    async signAmino(signDoc, address, transportBLE){
        await this.connect(INTERACTION_TIMEOUT, transportBLE)
        // console.log(this.cosmosApp)
        // console.log(signMessage)
        // console.log(txBody)
        // // console.log(txContext)
       
    }

    /* istanbul ignore next: maps a bunch of errors */
    checkLedgerErrors(
        { error_message, device_locked },
        {
            timeoutMessag = "Connection timed out. Please try again.",
            rejectionMessage = "User rejected the transaction"
        } = {}
    ) {
        if (device_locked) {
            throw new Error(`Ledger's screensaver mode is on`)
        }
        switch (error_message) {
        case `U2F: Timeout`:
            throw new Error(timeoutMessag)
        case `${Meteor.settings.public.ledger.appName} app does not seem to be open`:
            // hack:
            // It seems that when switching app in Ledger, WebUSB will disconnect, disabling further action.
            // So we clean up here, and re-initialize this.cosmosApp next time when calling `connect`
            this.cosmosApp.transport.close()
            this.cosmosApp = undefined
            throw new Error(`${Meteor.settings.public.ledger.appName} app is not open`)
        case `Command not allowed`:
            throw new Error(`Transaction rejected`)
        case `Transaction rejected`:
            throw new Error(rejectionMessage)
        case `Unknown error code`:
            throw new Error(`Ledger's screensaver mode is on`)
        case `Instruction not supported`:
            throw new Error(
                `Your ${Meteor.settings.public.ledger.appName} Ledger App is not up to date. ` +
                `Please update to version ${REQUIRED_COSMOS_APP_VERSION}.`
            )
        case `Web Bluetooth API globally disabled`:
            throw new Error(`Bluetooth not supported. Please use the latest version of Chrome browser.`)
        case `No errors`:
            // do nothing
            break
        default:
            throw new Error(error_message)
        }
    }

    static getBytesToSign(tx, txContext) {
        if (typeof txContext === 'undefined') {
            throw new Error('txContext is not defined');
        }
        if (typeof txContext.chainId === 'undefined') {
            throw new Error('txContext does not contain the chainId');
        }
        if (typeof txContext.accountNumber === 'undefined') {
            throw new Error('txContext does not contain the accountNumber');
        }
        if (typeof txContext.sequence === 'undefined') {
            throw new Error('txContext does not contain the sequence value');
        }

        const txFieldsToSign = {
            account_number: txContext.accountNumber.toString(),
            chain_id: txContext.chainId,
            fee: tx.auth_info.fee,
            memo: tx.body.memo,
            msgs: tx.body.messages,
            sequence: txContext.sequence.toString(),
        };

        // const bodyBytes = TxBody.encode(JSON.stringify(tx.body)).finish();
        // const authInfoBytes = AuthInfo.encode(JSON.stringify(tx.auth_info)).finish();

        // const signDoc = SignDoc({
        //     body_bytes: bodyBytes,
        //     auth_info_bytes: authInfoBytes,
        //     chain_id: txContext.chainId,
        //     account_number: Number(txContext.accountNumber)
        // });

        return JSON.stringify(canonicalizeJson(txFieldsToSign));
    }

    static applyGas(unsignedTx, gas, gasPrice=DEFAULT_GAS_PRICE, denom=DEFAULT_DENOM) {
        if (typeof unsignedTx === 'undefined') {
            throw new Error('undefined unsignedTx');
        }
        if (typeof gas === 'undefined') {
            throw new Error('undefined gas');
        }

        // eslint-disable-next-line no-param-reassign
        unsignedTx.auth_info.fee = {
            amount: [{
                amount: Math.ceil(gas * gasPrice).toString(),
                denom: denom,
            }],
            gas: gas.toString(),
        };

        return unsignedTx;
    }

    static applySignature(unsignedTx, txContext, secp256k1Sig) {
        if (typeof unsignedTx === 'undefined') {
            throw new Error('undefined unsignedTx');
        }
        if (typeof txContext === 'undefined') {
            throw new Error('undefined txContext');
        }
        if (typeof txContext.pk === 'undefined') {
            throw new Error('txContext does not contain the public key (pk)');
        }
        if (typeof txContext.accountNumber === 'undefined') {
            throw new Error('txContext does not contain the accountNumber');
        }
        if (typeof txContext.sequence === 'undefined') {
            throw new Error('txContext does not contain the sequence value');
        }

        const tmpCopy = Object.assign({}, unsignedTx, {});
        console.log(unsignedTx)
        tmpCopy.signatures[0] = secp256k1Sig.signature
        //  toUtf8(secp256k1Sig.toString('base64'))
        // encodeSecp256k1Signature(accountForAddress.pubkey, signature)
        // secp256k1Sig.toString('base64')
        return tmpCopy;
    }

    // Creates a new tx skeleton
    static createSkeleton(txContext, msgs=[]) {
        if (typeof txContext === 'undefined') {
            throw new Error('undefined txContext');
        }
        if (typeof txContext.accountNumber === 'undefined') {
            throw new Error('txContext does not contain the accountNumber');
        }
        if (typeof txContext.sequence === 'undefined') {
            throw new Error('txContext does not contain the sequence value');
        }
        const txSkeleton = {
            '@type': '/cosmos.tx.v1beta1.Tx',
            'body': {
                'messages': msgs,
                'memo': txContext.memo || DEFAULT_MEMO,
                'timeout_height': '0',
                'extension_options': [],
                'non_critical_extension_options': []
            },
            'auth_info':{
                'signer_infos': [{
                    'mode_info': {
                        'single': {
                            'mode': SignMode.SIGN_MODE_LEGACY_AMINO_JSON
                        }
                    },
                    'public_key': {
                        '@type': 'tendermint/PubKeySecp256k1',
                        'key': txContext.pk || 'PK',
                    },
                    'sequence': txContext.sequence.toString(),

                }],
                'fee': {
                    'amount': [{
                        'amount': '',
                        'denom': ''
                    }],
                    'gas_limit': '200000',
                    'payer': '',
                    'granter': ''
                },
            },
            'signatures': []
        };
        return txSkeleton
    }

    // Creates a new delegation tx based on the input parameters
    // the function expects a complete txContext
    static createDelegate(
        txContext,
        validatorBech32,
        uatomAmount
    ) {
        const txMsg = {
            '@type': '/cosmos.staking.v1beta1.MsgDelegate',
            'amount': {
                'amount': uatomAmount.toString(),
                'denom': txContext.denom,
            },
            'delegator_address': txContext.bech32,
            'validator_address': validatorBech32,
        };

        return Ledger.createSkeleton(txContext, [txMsg]);
    }

    // Creates a new undelegation tx based on the input parameters
    // the function expects a complete txContext
    static createUndelegate(
        txContext,
        validatorBech32,
        uatomAmount
    ) {
        const txMsg = {
            '@type': '/cosmos.staking.v1beta1.MsgUndelegate',
            'amount': {
                'amount': uatomAmount.toString(),
                'denom': txContext.denom,
            },
            'delegator_address': txContext.bech32,
            'validator_address': validatorBech32,
        };

        return Ledger.createSkeleton(txContext, [txMsg]);
    }

    // Creates a new redelegation tx based on the input parameters
    // the function expects a complete txContext
    static createRedelegate(
        txContext,
        validatorSourceBech32,
        validatorDestBech32,
        uatomAmount
    ) {
        const txMsg = {
            '@type': '/cosmos.staking.v1beta1.MsgBeginRedelegate',
            'amount': {
                'amount': uatomAmount.toString(),
                'denom': txContext.denom,
            },
            'delegator_address': txContext.bech32,
            'validator_dst_address': validatorDestBech32,
            'validator_src_address': validatorSourceBech32,
        };

        return Ledger.createSkeleton(txContext, [txMsg]);
    }

    // Creates a new transfer tx based on the input parameters
    // the function expects a complete txContext
    static createTransfer(
        txContext,
        toAddress,
        amount
    ) {
        const txMsg = {
            '@type': '/cosmos.bank.v1beta1.MsgSend',
            'amount': [{
                'amount': amount.toString(),
                'denom': txContext.denom
            }],
            'from_address': txContext.bech32,
            'to_address': toAddress
        };

        return Ledger.createSkeleton(txContext, [txMsg]);
    }

    static createSubmitProposal(
        txContext,
        title,
        description,
        deposit
    ) {
        const txMsg = {
            '@type': '/cosmos.gov.v1beta1.MsgSubmitProposal',
            
            'content': {
                '@type': '/cosmos.distribution.v1beta1.CommunityPoolSpendProposal',
                'amount': [{
                    'amount': deposit.toString(),
                    'denom': txContext.denom
                }],
                'description': description,
                'recipient': 'cosmos1s5afhd6gxevu37mkqcvvsj8qeylhn0rz46zdlq',
                'title': title,
            },
            'initial_deposit': [{
                'amount': deposit.toString(),
                'denom': txContext.denom
            }],
            'proposer': txContext.bech32
        };

        return Ledger.createSkeleton(txContext, [txMsg]);
    }

    static createVote(
        txContext,
        proposalId,
        option,
    ) {
        const txMsg = {
            '@type': '/cosmos.gov.v1beta1.MsgVote',
            'option': option,
            'proposal_id': proposalId.toString(),
            'voter': txContext.bech32.toString()
        };

        return Ledger.createSkeleton(txContext, [txMsg]);
    }

    static createDeposit(
        txContext,
        proposalId,
        amount,
    ) {
        const txMsg = {
            '@type': '/cosmos.​gov.v1beta1.MsgDeposit',
            'amount': [{
                'amount': amount.toString(),
                'denom': txContext.denom
            }],
            'depositor': txContext.bech32,
            'proposal_id': proposalId.toString()
        };

        return Ledger.createSkeleton(txContext, [txMsg]);
    }

}

function versionString({ major, minor, patch }) {
    return `${major}.${minor}.${patch}`
}

export const checkAppMode = (testModeAllowed, testMode) => {
    if (testMode && !testModeAllowed) {
        throw new Error(
            `DANGER: The ${Meteor.settings.public.ledger.appName} Ledger app is in test mode and shouldn't be used on mainnet!`
        )
    }
}

function canonicalizeJson(jsonTx) {
    if (Array.isArray(jsonTx)) {
        return jsonTx.map(canonicalizeJson);
    }
    if (typeof jsonTx !== 'object') {
        return jsonTx;
    }
    const tmp = {};
    Object.keys(jsonTx).sort().forEach((key) => {
        // eslint-disable-next-line no-unused-expressions
        jsonTx[key] != null && (tmp[key] = jsonTx[key]);
    });

    return tmp;
}
