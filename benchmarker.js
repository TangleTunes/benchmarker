const { result_to_obj, range } = require('./utils');
const {CHUNK_SIZE, SONG_INDEX, JSON_RPC_URL, FAUCET_URL, CHAIN_ID, CONTRACT_ADDR, ABI} = require('./constants')
const cliProgress = require('cli-progress');
const commander = require('commander');
const colors = require('ansi-colors');
const ethers = require('ethers');
const http = require('http');
const net = require('net');

commander
  .version('1.0.0', '-v, --version')
  .usage('[OPTIONS]...')
  .option('-s, --step <value>', 'Chunks per transaction', 10)
  .parse(process.argv);
const options = commander.opts();

var nonce;
const STEP = parseInt(options.step)
if (isNaN(STEP)) throw new commander.InvalidArgumentError('Step is not an integer value')

const provider = new ethers.JsonRpcProvider(JSON_RPC_URL, CHAIN_ID)
const signer = ethers.Wallet.createRandom().connect(provider)
const contract = new ethers.Contract(CONTRACT_ADDR, ABI, signer)

async function tx_payload(id, index, size, dist_addr) {
	//Create RLP encoded transaction (ready to be broadcasted)
	tx = await contract.get_chunks.populateTransaction(id, index, size, dist_addr, {
		nonce,
		gasLimit: 3000000
	})
	encoded_tx = await signer.signTransaction(await signer.populateTransaction(tx))
	//Encode transaction based on custom protocol
	return Buffer.concat([
		Buffer.from((new Uint32Array([ethers.dataLength(encoded_tx)])).buffer), // byte_length
		Buffer.from(ethers.getBytes(encoded_tx)), // data
	])

}

function update_state(data, state) {
	if (state.to_be_read == 0) {
		//decode protocol metadata
		index = data.readUInt32LE(0)
		length = data.readUInt32LE(4)
		//add bytes to be read and chunks received
		state.to_be_read = length - data.byteLength + 8
		range(...[Math.ceil(length/CHUNK_SIZE), index]).forEach(state.received.add, state.received)
		//console.log(`Received chunks #${index} to #${index + Math.ceil(length/CHUNK_SIZE)}`)
	} else if (data.byteLength > state.to_be_read) {
		//split two protocol packets
		subdata = data.slice(state.to_be_read)
		state.to_be_read = 0
		update_state(subdata, state)
		//full packet has been received
		return true
	} else {
		//skip file contents
		state.to_be_read -= data.byteLength
	}
	//return true if full packet has been received
	return state.to_be_read == 0
}

async function download_strategy(id, dist, chunks_length, sent_bar, recv_bar) {
	let state = {
		received: new Set(),
		to_be_read: 0,
		error: false,
		done: false
	}

	while (state.received.size < chunks_length) {
		const client = new net.Socket()

		client.connect(dist.port, dist.ip, async () => {
			for (let i = state.received.size; i < chunks_length; i += STEP) {
				if (state.error) return state.error = false
				let chunks = STEP < chunks_length - i ? STEP : chunks_length - i
				//console.log(`Sending chunks #${i} to #${i + chunks}`)
				await new Promise(async resolve => {
					client.write(await tx_payload(id, i, chunks, dist.address), () => {
						nonce += 1
						sent_bar.increment(chunks)
						resolve()
					})
				})
			}
			state.done = true
		})

		client.on('data', data => {
			full_packet_rec = update_state(data, state)
			if (full_packet_rec) {
				recv_bar.update(state.received.size)
				if (state.received.size == chunks_length) return client.destroy()
			}
		})

		await new Promise(resolve => client.on('close', () => {
			if (!client.destroyed) client.destroy()
			resolve()
		}))

		if (state.received.size < chunks_length) {
			if (!state.done) state.error = true
			while (state.error) {
				await new Promise(resolve => setTimeout(resolve, 20))
			}

			//Update state
			nonce = await signer.getNonce()
			state.to_be_read = 0
			sent_bar.update(state.received.size)
		}
	}
}

async function streaming_strategy(id, dist, chunks_length, sent_bar, recv_bar) {
	let state = {
		sent: 0,
		received: new Set(),
		to_be_read: 0,
		reading: false
	}

	while (state.received.size < chunks_length) {
		const client = new net.Socket()

		client.connect(dist.port, dist.ip, async () => {
			//console.log(`Sending chunks #0 to #${STEP}`)
			let chunks = STEP < chunks_length - state.received.size ? STEP : chunks_length - state.received.size
			client.write(await tx_payload(id, state.received.size, chunks, dist.address), () => {
				nonce += 1
				state.sent += STEP
				sent_bar.increment(STEP)
			})
		})

		client.on('data', async data => {
			state.reading = true
			try {
				full_packet_rec = update_state(data, state)
				if (full_packet_rec) {
					recv_bar.update(state.received.size)
					if (state.received.size == chunks_length) return client.destroy()
					if (state.received.size == state.sent) {
						let chunks = STEP < chunks_length - state.received.size ? STEP : chunks_length - state.received.size
						//console.log(`Sending chunks #${state.received.size} to #${state.received.size + chunks}`)
						client.write(await tx_payload(id, state.received.size, chunks, dist.address), () => {
							nonce += 1
							state.sent += chunks
							sent_bar.increment(chunks)
						})
					}
				}
			} finally {
				state.reading = false
			}
		})

		await new Promise(resolve => client.on('close', resolve))
		if (state.received.size < chunks_length) {
			while (state.reading) {
				await new Promise(resolve => setTimeout(resolve, 20))
			}
			nonce = await signer.getNonce()
			state.sent = state.received.size
			sent_bar.update(state.sent)
		}
	}
}

async function benchmark(name, strategy_fun, args, progress_bar) {
	console.log(`Benchmarking ${name} strategy...`)
	sent_bar = progress_bar.create(chunks_length, 0, { name: 'sent'})
	recv_bar = progress_bar.create(chunks_length, 0, { name: 'recv'})
	
	console.time(name)
	await strategy_fun(...args, sent_bar, recv_bar)
	progress_bar.stop()
	console.timeEnd(name)
}

async function main() {
	console.log('Creating new account...')
	//request funds
	await new Promise(resolve => http.get(FAUCET_URL + signer.address, resolve))
	//Create account
	tx = await contract.create_user('tester', '', {
		gasLimit: 3000000
	})
	await tx.wait()
	//Deposit funds
	tx = await contract.deposit({
		value: ethers.parseEther("10"),
		gasLimit: 3000000
	})
	await tx.wait()

	//Check correctness
	let user = result_to_obj(
		await contract.users(signer.address), 
		["exists", "name", "desc", "url", "balance", "is_validator"]
	)
	if (user.exists) {
		console.log('Account succesfully created. balance: ' + ethers.formatEther(user.balance))
	} else {
		throw new Error('Account failed to create');
	}

	//Get distribution info
	song = result_to_obj(
		(await contract.get_songs(SONG_INDEX, 1))[0], 
		["id", "name", "author_name", "price", "length", "duration"]
	)
	distributor = result_to_obj(
		await contract.get_rand_distributor(song.id, 0), 
		["address", "url", "fee"]
	)
	chunks_length = Number(await contract.chunks_length(song.id))
	console.log(`Requesting ${song.name} (${song.id}) from ${distributor.url} ${STEP} chunks per tx`)
	dist = {
		address: distributor.address,
		ip: distributor.url.split(':')[0],
		port: parseInt(distributor.url.split(':')[1])
	}

	nonce = await signer.getNonce()
	const progress_bar = new cliProgress.MultiBar({
		format: '{name} |' + colors.cyan('{bar}') + '| {percentage}% || {value}/{total} Chunks',
		barCompleteChar: '\u2588',
		barIncompleteChar: '\u2591',
		hideCursor: true,
		stopOnComplete: true
	});


	await benchmark('Download', download_strategy, [song.id, dist, chunks_length], progress_bar)


	await benchmark('Streaming', streaming_strategy, [song.id, dist, chunks_length], progress_bar)
}

main()