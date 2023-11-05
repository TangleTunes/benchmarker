# benchmarker
Scripts to benchmark TangleTunes performance

## Installation

The scripts are written as nodejs code. To install all dependencies:
```
npm install
```

All configuration values can be changed in `constants.js`. It is important to choose the correct song with `SONG_INDEX`, point to the correct smart contract with `CONTRACT_ADDR`, and to point to the correct iota node by changing the different URLs in the file.

## Benchmark
The benchmarker script will request the desired song using different strategies and show the exact loading time.
```
> node .\benchmarker.js --help
Usage: benchmarker [OPTIONS]...

Options:
  -v, --version       output the version number
  -s, --step <value>  Chunks per transaction (default: 10)
  -h, --help          display help for command
```

## Stress
The stresser script will send the desired base traffic to the TangleTunes platform on either the first or second ledger.
```
> node .\stresser.js --help
Usage: stresser [OPTIONS]...

Options:
  -v, --version         output the version number
  -l, --ledger <value>  Target ledger (L1 or L2) (default: "L2")
  -a, --amount <value>  Amount of stress in tx/s (default: 5)
  -h, --help            display help for command
``` 

## License
The code in this repository is licensed under the MIT License. See the [LICENSE](./LICENSE) file for details.
