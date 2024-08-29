# DI Lending

This is a decentralized lending and borrowing protocol built from scratch, inspired from the AAVE protocol. It's designed to provide users with the ability to provide ERC20 tokens as collaterals and borrow other ERC20 assets against them in a secure and efficient manner.

## Key Features

* **LendingPool Contract**: The main component of the protocol, where users can supply collateral and borrow assets. Users can interact with this contract to manage their positions.

* **Supply and Borrow**: Any user can execute common `supply`/`borrow`/`repay` operations in order to deposit ERC20 collateral, borrow against them and repay the borrowed amout plus interest that goes to the lenders, similar to the AAVE protocol.

* **ERC20 Liquidation Mechanism**: If a user's health factor falls below a certain threshold, their position becomes liquidatable. Any user can execute the `liquidate` call to repay the defaulted borrower's borrows and receive a liquidation bonus as an incentive for their action.

* **Interest Model**: the protocol follows an interest rate model similar to AAVE V2 to ensure that borrowers and lenders are incentivized appropriately.

* **Protocol Fee**: The protocol owner may choose to impose a fee, capped at a maximum of 10% of the interest accrued, on a specific asset included in the lending pool. This fee will be collected each time interest is earned.

* **Asset Price Oracle**: Asset prices in USD are determined using the Chainlink oracle price feeds, for ERC20 tokens the normal market prices are fetched from the oracle.

## Getting Started

Steps to run the tests: (Hardhat version 2.19.0)

### Clone this repo

```shell
git clone https://github.com/petro1912/di-lending
```

### Installs all of the files

```shell
yarn install
```

### Setup environment variables for real/test networks 

> Create .env file with env var PRIVATE_KEY= , POLYGON_RPC_URL= , POLYGONSCAN_API_KEY= (use http://alchemy.com)

### Compiles all of the contracts

```shell
yarn compile
```

### Deploy lending pool
```shell
yarn deploy --<network-name>
```

### Runs all of the tests

```shell
yarn test
```

### Displays the coverage of the contracts

```shell
yarn coverage
```
