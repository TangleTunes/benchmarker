const { HORNET_API_URL, SONG_INDEX, JSON_RPC_URL, FAUCET_URL, CHAIN_ID, CONTRACT_ADDR, ABI } = require('./constants')
const { getRandomInt, result_to_obj } = require('./utils');
const { Wallet, CoinType, Utils } = require('@iota/sdk');
const cliProgress = require('cli-progress');
const commander = require('commander');
const colors = require('ansi-colors');
const ethers = require('ethers');
const http = require('http');
const fs = require('fs');
const retry = require('async/retry')

commander
  .version('1.0.0', '-v, --version')
  .usage('[OPTIONS]...')
  .option('-l, --ledger <value>', 'Target ledger (L1 or L2)', 'L2')
  .option('-a, --amount <value>', 'Amount of stress in tx/s', 5)
  .parse(process.argv);
const options = commander.opts();

//check target ledger
if (!['L1', 'L2'].includes(options.ledger)) throw new commander.InvalidArgumentError('Unrecognized ledger')
//parse and check stress amount
const STRESS = parseInt(options.amount)
if (isNaN(STRESS)) throw new commander.InvalidArgumentError('Stress amount is not an integer value')

// Initialize EVM provider
const provider = options.ledger == 'L2' ? new ethers.JsonRpcProvider(JSON_RPC_URL, CHAIN_ID) : undefined
// Initialize IOTA wallet and options
if (options.ledger == 'L1' && fs.existsSync('iota')) fs.rmSync('iota', { recursive: true })
const wallet = options.ledger == 'L1' ? new Wallet({
    storagePath: 'iota/wallet.db',
    clientOptions: {
        nodes: [HORNET_API_URL], // Hornet API
    },
    coinType: CoinType.IOTA,
    secretManager: {
        stronghold: {
            snapshotPath: 'iota/vault.stronghold',
            password: 'password',
        },
    },
}) : undefined
const syncOptions = options.ledger == 'L1' ? {
    alias: {
        basicOutputs: true,
    },
} : undefined

function setup_visualizers(length) {
    const bars = new cliProgress.MultiBar({
		format: '{name} |' + colors.cyan('{bar}') + '| {percentage}% || {value}/{total}',
		barCompleteChar: '\u2588',
		barIncompleteChar: '\u2591',
		hideCursor: true
	})
    return {
        time_vis: bars.create(2000, 0, { name: "Time between rounds" }),
        sent_vis: bars.create(STRESS, 0, { name: "Transactions sent" }),
        pool_vis: bars.create(length, 0, { name: "Available accounts" })
    }
}

function funds_received(acc, ttl) {
    return new Promise((resolve, reject) => {
        // Print balance with local data after syncing the state
        acc.sync().then(() => {
            acc.getBalance().then(bal => {
                //console.log(`Waiting funds (ttl:${ttl}) (bal:${bal.baseCoin.available})`)
                if (bal.baseCoin.available > BigInt(0)) {
                    resolve(bal.baseCoin.available)
                } else if (ttl > 0) {
                    setTimeout(() => {
                        funds_received(acc, ttl - 1)
                            .then(resolve)
                            .catch(e => reject(e))
                    }, 2000)
                } else {
                    reject('timeout')
                }
            }).catch(e => console.log(e))
        }).catch(() => {
            funds_received(acc, ttl - 1)
                .then(resolve)
                .catch(e => reject(e))
        })
    })
}

async function stress_evm() {
    //populate_accounts
    console.log(`Preparing ${STRESS * 10} TangleTunes accounts for stress test... (may take a few minutes)`)
    const accounts = await Promise.all(
        [...Array(STRESS * 10).keys()].map(async id => {
            let signer = ethers.Wallet.createRandom().connect(provider)
            let contract = new ethers.Contract(CONTRACT_ADDR, ABI, signer)
            //request funds
            await new Promise(res => setTimeout(res, 30_000 * Math.floor(id/10)))
	        await new Promise(resolve => http.get(FAUCET_URL + signer.address, resolve))
            //Create account
            tx = await contract.create_user(`stresser #${id}`, '', {
                gasLimit: 3000000
            })
            await tx.wait()
            //Deposit funds
            tx = await contract.deposit({
                value: ethers.parseEther("10"),
                gasLimit: 3000000
            })
            await tx.wait()
            //verify that account was created
            let user = result_to_obj(
                await contract.users(signer.address), 
                ["exists", "name", "desc", "url", "balance", "is_validator"]
            )
            if (!user.exists) throw new Error(`Account #${id} failed to create`);
            console.log((`Account #${id} ready`))
            //return account ready for stress test
            return {
                contract: contract,
                ready: true
            }
        })
    )

    //Get distribution info
    const contract = new ethers.Contract(CONTRACT_ADDR, ABI, provider)
	song = result_to_obj(
		(await contract.get_songs(SONG_INDEX, 1))[0], 
		["id", "name", "author_name", "price", "length", "duration"]
	)
	distributor = result_to_obj(
		await contract.get_rand_distributor(song.id, 0), 
		["address", "url", "fee"]
	)
	chunks_length = Number(await contract.chunks_length(song.id))
    
    //Initialize status visualizers
    var last_time = new Date()
    const { time_vis, sent_vis, pool_vis } = setup_visualizers()

    //Stress test
    console.log(`stressing the evm with ${STRESS} tx/s`)
    setInterval(async () => {
        let state = {
            available: 0,
            left_to_send: STRESS,
            barrier: 0
        }

        //Handle accounts: only send tx if possible and needed
        accounts.forEach(async acc => {
            // Do not sent tx if not needed or last tx has not been confirmed yet
            if (state.left_to_send == 0 || !acc.ready) {
                state.available += acc.ready ? 1 : 0
                return state.barrier++
            }
            state.left_to_send -= 1
            state.barrier++
            // Sending tx
            acc.ready = false
            try {
                tx = await acc.contract.get_chunks(song.id, getRandomInt(chunks_length), 1, distributor.address, {
                    gasLimit: 3000000
                })
                await tx.wait()
            } catch (error) {
                //console.log(error)
            } finally {
                acc.ready = true
            }
        })

        //wait until all accounts have been handled
        while (state.barrier < accounts.length) {}

        //visualize status
        let time = new Date()
        time_vis.update(time.getTime() - last_time.getTime())
        last_time = time
        sent_vis.update(STRESS - state.left_to_send)
        pool_vis.update(state.available)
    }, 1000)
}

async function stress_tangle() {
    //Create wallet
    await wallet.storeMnemonic(Utils.generateMnemonic())
    const client = await wallet.getClient()
    //TODO: populate_accounts
    console.log(`Preparing ${STRESS * 10} pairs of IOTA wallets for stress test... (may take a few minutes)`)
    const accounts = await Promise.all(
        [...Array(STRESS * 10).keys()].map(async id => {
            // Create accounts
            const sendr_acc = await wallet.createAccount({ alias: `sendr#${id}` })
            const recvr_acc = await wallet.createAccount({ alias: `recvr#${id}` })
            //request funds in batches of 10
            await new Promise(res => setTimeout(res, 10_000 * Math.floor(id/10)))
            await new Promise(res => retry(
                5,
                async () => {
                    await client.requestFundsFromFaucet('http://raspi.local:8091/api/enqueue', (await sendr_acc.addresses())[0].address)
                    return await funds_received(sendr_acc, 5)
                },
                (err, result) => {
                    if (!err) {
                        //verify that balances are correct
                        if (result != BigInt(100_000_000_000)) {
                            throw new Error(`sendr#${id} did not receive funds`);
                        }
                        return res()
                    }
                }
            ))
            //return account ready for stress test
            return {
                sendr: sendr_acc,
                recvr: recvr_acc,
                ready: true
            }
        })
    )

    //Initialize status visualizers
    var last_time = new Date()
    const { time_vis, sent_vis, pool_vis } = setup_visualizers(accounts.length)

    //TODO: Stress test
    console.log(`stressing the tangle with ${STRESS} tx/s`)
    setInterval(async () => {
        let state = {
            available: 0,
            left_to_send: STRESS,
            barrier: 0
        }

        //Handle accounts: send funds from one account to the other
        accounts.forEach(async pair => {
            //TODO: check if return necessary
            // Do not sent tx if not needed or last tx has not been confirmed yet
            if (state.left_to_send == 0 || !pair.ready) {
                state.available += pair.ready ? 1 : 0
                return state.barrier++
            }
            state.left_to_send--
            state.barrier++
            // Send transaction
            pair.ready = false
            try {
                await pair.sendr.sync()
                tx = await pair.sendr.send(
                    BigInt(1_000_000), 
                    (await pair.recvr.addresses())[0].address
                )
                blockId = await pair.sendr.retryTransactionUntilIncluded(tx.transactionId)
                //console.log(`tx sent: http://raspi.local:8081/dashboard/explorer/block/${blockId}`)
            } catch (error) {
                console.error(error)
            } finally {
                pair.ready = true
            }
            
        })

        //wait until all accounts have been handled
        while (state.barrier < accounts.length) {}

        //visualize status
        let time = new Date()
        time_vis.update(time.getTime() - last_time.getTime())
        last_time = time
        sent_vis.update(STRESS - state.left_to_send)
        pool_vis.update(state.available)
    }, 1000)
}

if (options.ledger == 'L1') {
    stress_tangle()
} else {
    stress_evm()
}