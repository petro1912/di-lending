const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const {
  getAmountInWei,
  getAmountFromWei,
  mintAndapproveERC20,
  deployERC20Mock,
  developmentChains,
  mintERC20,
  approveERC20,
  deployAggregatorMock,
  scaleAmount,
  normalizeAmount,
  round,
  moveTime
} = require("../utils/helpers");


let pool;
let DAI, WETH, WBTC;
let daiFeed, wethFeed, wbtcFeed;

// use same vault params by default for testing
let vaultInfoParams = {
  reserveRatio: 20000, // 20%
  feeToProtocolRate: 1000, // 1%
  flashFeeRate: 500, // 0.5%
  optimalUtilization: getAmountInWei(0.8), // 80%
  baseRate: 0,
  slope1: getAmountInWei(0.04), // 4%
  slope2: getAmountInWei(3), // 300%
};

!developmentChains.includes(network.name)
  ? describe.skip
  : describe("Lending Pool Unit Tests", () => {
      before(async () => {
        [owner, user1, user2, user3, randomUser] = await ethers.getSigners();
      });

      describe("Correct Deployement", () => {
        before(async () => {
          // Deploy ERC20 and USD price feeds mocks
          [DAI, WETH, WBTC, daiFeed, wethFeed, wbtcFeed] =
            await deployTokenMocks();

          // Deploy Lending Pool contract
          pool = await deployPool(DAI.target, daiFeed.target, vaultInfoParams);
        });
        it("Lending Pool contract should have correct owner address", async () => {
          const ownerAddress = await owner.getAddress();
          expect(await pool.owner()).to.equal(ownerAddress);
        });
        it("Lending Pool contract should be in paused state", async () => {
          expect(await pool.pausedStatus(ethers.ZeroAddress)).to.equal(true);
        });
        it("should add DAI as supported token", async () => {
          expect(await pool.getTokenPrice(DAI.target)).to.equal(
            getAmountInWei(1)
          );
        });
      });

      describe("Core Functions", () => {
        describe("ERC20 Logic functions", () => {
          describe("supply()", () => {
            const ethSuppliedAmount = getAmountInWei(10); // 10 ETH
            const wbtcSuppliedAmount = scaleAmount(5, 8); // 5 wBTC
            let beforePoolbalance;
            before(async () => {
              // Deploy ERC20 and USD price feeds mocks
              [DAI, WETH, WBTC, daiFeed, wethFeed, wbtcFeed] =
                await deployTokenMocks();

              // Deploy Lending Pool contract
              pool = await deployPool(
                DAI.target,
                daiFeed.target,
                vaultInfoParams
              );
            });
            it("should revert if pool is paused", async () => {
              await mintAndapproveERC20(
                user1,
                WETH.target,
                ethSuppliedAmount,
                pool.target
              );

              await expect(
                pool.connect(user1).supply(WETH.target, ethSuppliedAmount, 0)
              ).to.be.revertedWithCustomError(pool, "isPaused");
            });
            it("should revert if ERC20 token is not supported", async () => {
              // unpause lending pool
              await pool
                .connect(owner)
                .setPausedStatus(ethers.ZeroAddress, false);

              await expect(
                pool.connect(user1).supply(WETH.target, ethSuppliedAmount, 0)
              ).to.be.revertedWithCustomError(pool, "TokenNotSupported");
            });
            it("should allow user to supply supported ERC20 tokens", async () => {
              beforePoolbalance = getAmountFromWei(
                await WETH.balanceOf(pool.target)
              );
              await setupTokenVault(
                WETH.target,
                wethFeed.target,
                vaultInfoParams,
                true
              );

              await expect(
                pool.connect(user1).supply(WETH.target, ethSuppliedAmount, 0)
              )
                .to.emit(pool, "Deposit")
                .withArgs(
                  user1.address,
                  WETH.target,
                  ethSuppliedAmount,
                  ethSuppliedAmount // shares equal amount for first depositor
                );
            });
            it("should transfer supplied amount to pool", async () => {
              const afterPoolbalance = getAmountFromWei(
                await WETH.balanceOf(pool.target)
              );
              expect(afterPoolbalance).to.be.equal(
                getAmountFromWei(ethSuppliedAmount) + beforePoolbalance
              );
            });
            it("should add shares/amount to the token vault", async () => {
              const vault = await pool.getTokenVault(WETH.target);
              expect(vault.totalAsset.amount).to.equal(ethSuppliedAmount);
              // for first supply we have shares == amount
              expect(vault.totalAsset.shares).to.equal(ethSuppliedAmount);
            });
            it("should update user collateral balance", async () => {
              const tokenCollateralAmount = (
                await pool.getUserTokenCollateralAndBorrow(
                  user1.address,
                  WETH.target
                )
              )[0];
              expect(tokenCollateralAmount).to.equal(ethSuppliedAmount);
            });
            it("should calculate correct shares to new suppliers", async () => {
              await setupTokenVault(
                WBTC.target,
                wbtcFeed.target,
                vaultInfoParams,
                true
              );

              // user 2 supplies WBTC to borrow WETH
              await mintERC20(user2, WBTC.target, wbtcSuppliedAmount);
              await supply(user2, WBTC.target, wbtcSuppliedAmount, pool);
              // user 2 borrows 5 ETH
              await pool.connect(user2).borrow(WETH.target, getAmountInWei(5));

              await hre.network.provider.send("hardhat_mine", ["0x4e20"]);
              await pool.connect(user2).accrueInterest(WETH.target);

              const vault = await pool.getTokenVault(WETH.target);
              const beforeAssetShares = getAmountFromWei(
                vault.totalAsset.shares
              );
              const beforeAssetAmount = getAmountFromWei(
                vault.totalAsset.amount
              );

              // user 3 supplies ETH
              const user3Amount = getAmountInWei(20); // 20 ETH
              await mintERC20(user3, WETH.target, user3Amount);
              await supply(user3, WETH.target, user3Amount, pool);
              const collateralShares = (
                await pool.getUserTokenCollateralAndBorrow(
                  user3.address,
                  WETH.target
                )
              )[0];

              const expectedShares = parseFloat(
                (getAmountFromWei(user3Amount) * beforeAssetShares) /
                  beforeAssetAmount
              ).toFixed(3);
              expect(
                parseFloat(getAmountFromWei(collateralShares)).toFixed(3)
              ).to.be.equal(expectedShares);
            });
            it("should revert if below minimum expected shares", async () => {
              // user 1 supplies ETH(WETH)
              const amount = getAmountInWei(30); // 30 ETH
              await mintAndapproveERC20(
                user1,
                WETH.target,
                amount,
                pool.target
              );
              // Expect no slippage
              const minSharesOut = await pool.sharesToAmount(
                WETH.target,
                amount,
                false
              );

              // tx stays in mempool for some 10 blocks
              await hre.network.provider.send("hardhat_mine", ["0xa"]);
              await pool.connect(user1).accrueInterest(WETH.target);

              await expect(
                pool.connect(user1).supply(WETH.target, amount, minSharesOut)
              ).to.be.revertedWithCustomError(pool, "TooHighSlippage");
            });
            it("should revert if token vault is paused", async () => {
              // pause ETH vault
              await pool.connect(owner).setPausedStatus(WETH.target, true);

              await expect(
                pool.connect(user1).supply(WETH.target, ethSuppliedAmount, 0)
              ).to.be.revertedWithCustomError(pool, "isPaused");

              // Lending pool still allows WBTC vault supply
              await mintAndapproveERC20(
                user1,
                WBTC.target,
                wbtcSuppliedAmount,
                pool.target
              );
              await pool
                .connect(user1)
                .supply(WBTC.target, wbtcSuppliedAmount, 0);
            });
          });
          describe("borrow()", () => {
            before(async () => {
              // Deploy ERC20 and USD price feeds mocks
              [DAI, WETH, WBTC, daiFeed, wethFeed, wbtcFeed] =
                await deployTokenMocks();

              // Deploy Lending Pool contract
              pool = await deployPool(
                DAI.target,
                daiFeed.target,
                vaultInfoParams
              );

              // add supported ERC20 tokens
              await setupTokenVault(
                WETH.target,
                wethFeed.target,                
                vaultInfoParams,
                true
              );
              await setupTokenVault(
                WBTC.target,
                wbtcFeed.target,
                vaultInfoParams,
                true
              );
            });
            const borrowAmount = getAmountInWei(5); // 5 ETH
            let beforeBorrowerBalance;
            it("should revert if lending pool is paused", async () => {
              await expect(
                pool.connect(user1).borrow(WETH.target, borrowAmount)
              ).to.be.revertedWithCustomError(pool, "isPaused");
            });
            it("should revert if insufficient ERC20 token balance", async () => {
              // unpause pool
              await pool
                .connect(owner)
                .setPausedStatus(ethers.ZeroAddress, false);

              await expect(
                pool.connect(user2).borrow(WBTC.target, borrowAmount)
              ).to.be.revertedWithCustomError(pool, "InsufficientBalance");
            });
            it("should allow user to borrow supported ERC20 tokens", async () => {
              // user 1 supplies WETH
              await mintERC20(user1, WETH.target, getAmountInWei(40)); // 40 ETH
              await supply(user1, WETH.target, getAmountInWei(40), pool);

              beforeBorrowerBalance = getAmountFromWei(
                await WETH.balanceOf(user2.address)
              );

              // user 2 supplies token2
              const amount = scaleAmount(10, 8); // 10 BTC
              await mintERC20(user2, WBTC.target, amount);
              await supply(user2, WBTC.target, amount, pool);

              // user2 borrows token 1

              await expect(
                pool.connect(user2).borrow(WETH.target, borrowAmount)
              )
                .to.emit(pool, "Borrow")
                .withArgs(
                  user2.address,
                  WETH.target,
                  borrowAmount,
                  borrowAmount // shares equal amount for first borrower
                );
            });
            it("should transfer borrow amount to borrower", async () => {
              const afterBorrowerbalance = getAmountFromWei(
                await WETH.balanceOf(user2.address)
              );
              expect(afterBorrowerbalance).to.be.equal(
                getAmountFromWei(borrowAmount) + beforeBorrowerBalance
              );
            });
            it("should add borrow shares/amount to the token vault", async () => {
              const vault = await pool.getTokenVault(WETH.target);
              expect(vault.totalBorrow.amount).to.equal(borrowAmount);
              // for first borrower we have shares == amount
              expect(vault.totalBorrow.shares).to.equal(borrowAmount);
            });
            it("should update user borrow shares balance", async () => {
              const tokenBorrowAmount = (
                await pool.getUserTokenCollateralAndBorrow(
                  user2.address,
                  WETH.target
                )
              )[1];
              expect(tokenBorrowAmount).to.equal(borrowAmount);
            });
            it("should calculate correct shares for new borrowers", async () => {
              // user 2 supplies token2 and borrows WETH
              const suppliedAmount = scaleAmount(1.5, 8); //1.5 WBTC
              await mintERC20(user3, WBTC.target, suppliedAmount);
              await supply(user3, WBTC.target, suppliedAmount, pool);

              // virtually mine some blocks
              await hre.network.provider.send("hardhat_mine", ["0x4e20"]);

              // update chainlink price feed to avoid Invalid_Price error
              await wethFeed.updateAnswer(scaleAmount(2000, 8)); //1 ETH = 2000$
              await wbtcFeed.updateAnswer(scaleAmount(30000, 8)); //1 WBTC = 30000$
              await pool.connect(user2).accrueInterest(WETH.target);

              // user3 borrows 10 WETH
              await pool.connect(user3).borrow(WETH.target, getAmountInWei(10));

              const expectedShares = getAmountFromWei(
                await pool.amountToShares(
                  WETH.target,
                  getAmountInWei(10),
                  false
                )
              );
              const borrowShares = (
                await pool.getUserTokenCollateralAndBorrow(
                  user3.address,
                  WETH.target
                )
              )[1];
              expect(
                parseFloat(getAmountFromWei(borrowShares)).toFixed(5)
              ).to.be.equal(parseFloat(expectedShares).toFixed(5));
            });
            it("should revert if borrower is below health factor", async () => {
              // user3 tries to borrow more WETH
              await expect(
                pool.connect(user3).borrow(WETH.target, getAmountInWei(10))
              ).to.be.revertedWithCustomError(pool, "BelowHeathFactor");
            });
            it("should revert if token vault is paused", async () => {
              // pause ETH vault
              await pool.connect(owner).setPausedStatus(WETH.target, true);
              await expect(
                pool.connect(user3).borrow(WETH.target, getAmountInWei(5))
              ).to.be.revertedWithCustomError(pool, "isPaused");
            });
          });
          describe("repay()", () => {
            before(async () => {
              // Deploy ERC20 and USD price feeds mocks
              [DAI, WETH, WBTC, daiFeed, wethFeed, wbtcFeed] =
                await deployTokenMocks();

              // Deploy Lending Pool contract
              pool = await deployPool(
                DAI.target,
                daiFeed.target,
                vaultInfoParams
              );

              // unpause pool
              await pool
                .connect(owner)
                .setPausedStatus(ethers.ZeroAddress, false);

              // add supported ERC20 tokens
              await setupTokenVault(
                WETH.target,
                wethFeed.target,
                vaultInfoParams,
                true
              );
              await setupTokenVault(
                WBTC.target,
                wbtcFeed.target,
                vaultInfoParams,
                true
              );

              // user 1 supplies WETH
              await mintERC20(user1, WETH.target, getAmountInWei(40)); // 40 ETH
              await supply(user1, WETH.target, getAmountInWei(40), pool);

              // user 2 supplies token2
              const amount = scaleAmount(10, 8); // 10 WBTC
              await mintERC20(user2, WBTC.target, amount);
              await supply(user2, WBTC.target, amount, pool);

              // user2 borrows WETH
              await pool.connect(user2).borrow(WETH.target, getAmountInWei(20));

              // mine some blocks
              await hre.network.provider.send("hardhat_mine", ["0xa"]);
            });
            let beforePoolbalance,
              beforePoolBorrowShares,
              beforePoolBorrowAmount,
              beforeUserBorrowShares,
              repaidAmount,
              repaidShares,
              actualRepayAmount,
              actualRepayShares;
            it("should allow user to repay borrowed amount", async () => {
              const vault = await pool.getTokenVault(WETH.target);
              beforePoolBorrowShares = getAmountFromWei(
                vault.totalBorrow.shares
              );
              beforePoolBorrowAmount = getAmountFromWei(
                vault.totalBorrow.amount
              );
              beforePoolbalance = getAmountFromWei(
                await WETH.balanceOf(pool.target)
              );
              beforeUserBorrowShares = getAmountFromWei(
                (
                  await pool.getUserTokenCollateralAndBorrow(
                    user2.address,
                    WETH.target
                  )
                )[1]
              );
              repaidAmount = getAmountInWei(15);
              repaidShares = await pool.amountToShares(
                WETH.target,
                repaidAmount,
                false
              );
              await approveERC20(user2, WETH.target, repaidAmount, pool.target);

              pool.on("Repay", (borrower, token, repayAmount, repayShares) => {
                expect(borrower).to.equal(user2.address);
                expect(token).to.equal(WETH.target);
                actualRepayAmount = repayAmount;
                actualRepayShares = repayShares;
              });

              // user2 repays 35 WETH
              await expect(
                pool.connect(user2).repay(WETH.target, repaidAmount)
              ).to.emit(pool, "Repay");
              expect(actualRepayAmount).to.equal(repaidAmount);
              expect(actualRepayShares).to.lessThanOrEqual(repaidShares);
            });
            it("should transfer repaid amount to pool", async () => {
              const afterPoolbalance = getAmountFromWei(
                await WETH.balanceOf(pool.target)
              );
              expect(afterPoolbalance).to.be.equal(
                getAmountFromWei(repaidAmount) + beforePoolbalance
              );
            });
            it("should update borrow shares/amount in the token vault", async () => {
              const vault = await pool.getTokenVault(WETH.target);
              expect(
                round(getAmountFromWei(vault.totalBorrow.amount))
              ).to.equal(
                beforePoolBorrowAmount - getAmountFromWei(repaidAmount)
              );
              expect(
                round(getAmountFromWei(vault.totalBorrow.shares))
              ).to.equal(
                beforePoolBorrowShares - getAmountFromWei(repaidShares)
              );
            });
            it("should update user borrow shares balance", async () => {
              const afterBorrowShares = getAmountFromWei(
                (
                  await pool.getUserTokenCollateralAndBorrow(
                    user2.address,
                    WETH.target
                  )
                )[1]
              );
              expect(round(afterBorrowShares)).to.equal(
                beforeUserBorrowShares - getAmountFromWei(repaidShares)
              );
            });
            it("should allow user to repay full amount", async () => {
              let vault = await pool.getTokenVault(WETH.target);
              beforePoolBorrowShares = getAmountFromWei(
                vault.totalBorrow.shares
              );
              beforePoolBorrowAmount = getAmountFromWei(
                vault.totalBorrow.amount
              );
              repaidShares = (
                await pool.getUserTokenCollateralAndBorrow(
                  user2.address,
                  WETH.target
                )
              )[1];
              repaidAmount = await pool.sharesToAmount(
                WETH.target,
                repaidShares,
                false
              );

              // user2 repays full amount, providing big number
              await mintAndapproveERC20(
                user2,
                WETH.target,
                getAmountInWei(100),
                pool.target
              );

              pool.on("Repay", (borrower, token, repayAmount, repayShares) => {
                expect(borrower).to.equal(user2.address);
                expect(token).to.equal(WETH.target);
                expect(repayShares).to.equal(repaidShares);
                expect(repayAmount).to.greaterThanOrEqual(repaidAmount);
              });

              // user2 repays full borrowed amount by inputting a big value
              await expect(
                pool.connect(user2).repay(WETH.target, getAmountInWei(100000))
              ).to.emit(pool, "Repay");

              const afterBorrowShares = getAmountFromWei(
                (
                  await pool.getUserTokenCollateralAndBorrow(
                    user2.address,
                    WETH.target
                  )
                )[1]
              );
              expect(round(afterBorrowShares)).to.equal(0);
            });
          });
          describe("withdraw()", () => {
            before(async () => {
              // Deploy ERC20 and USD price feeds mocks
              [DAI, WETH, WBTC, daiFeed, wethFeed, wbtcFeed] =
                await deployTokenMocks();

              // Deploy Lending Pool contract
              pool = await deployPool(
                DAI.target,
                daiFeed.target,
                vaultInfoParams
              );

              // unpause pool
              await pool
                .connect(owner)
                .setPausedStatus(ethers.ZeroAddress, false);

              // add supported ERC20 tokens
              await setupTokenVault(
                WETH.target,
                wethFeed.target,
                vaultInfoParams,
                true
              );
              await setupTokenVault(
                WBTC.target,
                wbtcFeed.target,
                vaultInfoParams,
                true
              );

              // user 1 supplies WETH
              await mintERC20(user1, WETH.target, getAmountInWei(40));
              await supply(user1, WETH.target, getAmountInWei(40), pool);
            });
            it("should revert if withdraw amount is greater than supply balance", async () => {
              await expect(
                pool
                  .connect(user1)
                  .withdraw(WETH.target, getAmountInWei(50), getAmountInWei(50))
              ).to.be.revertedWithCustomError(pool, "InsufficientBalance");
            });
            let beforeUserbalance,
              beforePoolAssetShares,
              beforePoolAssetAmount,
              beforeUserAssetShares,
              withdrawAmount,
              withdrawnShares;
            it("should allow user to withdraw supplied amount", async () => {
              // user 2 supplies token2
              let amount = getAmountInWei(5);
              await mintERC20(user2, WBTC.target, amount);
              await supply(user2, WBTC.target, amount, pool);

              // user2 borrows token 1
              await pool.connect(user2).borrow(WETH.target, getAmountInWei(10));

              // tx stays in mempool for some 10 blocks
              await hre.network.provider.send("hardhat_mine", ["0xa"]);

              const vault = await pool.getTokenVault(WETH.target);
              beforePoolAssetShares = getAmountFromWei(vault.totalAsset.shares);
              beforePoolAssetAmount = getAmountFromWei(vault.totalAsset.amount);
              beforeUserbalance = getAmountFromWei(
                await WETH.balanceOf(user1.address)
              );
              beforeUserAssetShares = getAmountFromWei(
                (
                  await pool.getUserTokenCollateralAndBorrow(
                    user1.address,
                    WETH.target
                  )
                )[0]
              );
              withdrawAmount = getAmountInWei(10);
              withdrawnShares = await pool.amountToShares(
                WETH.target,
                withdrawAmount,
                false
              );

              pool.on("Withdraw", (user, token, repayAmount, repayShares) => {
                expect(user).to.equal(user1.address);
                expect(token).to.equal(WETH.target);
                expect(repayAmount).to.equal(withdrawAmount);
                expect(repayShares).to.lessThanOrEqual(withdrawnShares);
              });

              // user1 withdraws 10 WETH
              await expect(
                pool
                  .connect(user1)
                  .withdraw(WETH.target, withdrawAmount, withdrawnShares)
              ).to.emit(pool, "Withdraw");
            });
            it("should transfer withdrawn amount to user", async () => {
              const afterUserbalance = getAmountFromWei(
                await WETH.balanceOf(user1.address)
              );
              expect(afterUserbalance).to.be.equal(
                getAmountFromWei(withdrawAmount) + beforeUserbalance
              );
            });
            it("should update asset shares/amount in the token vault", async () => {
              const vault = await pool.getTokenVault(WETH.target);
              expect(round(getAmountFromWei(vault.totalAsset.amount))).to.equal(
                beforePoolAssetAmount - getAmountFromWei(withdrawAmount)
              );
              expect(round(getAmountFromWei(vault.totalAsset.shares))).to.equal(
                beforePoolAssetShares - getAmountFromWei(withdrawnShares)
              );
            });
            it("should update user asset balance", async () => {
              const afterAssetShares = getAmountFromWei(
                (
                  await pool.getUserTokenCollateralAndBorrow(
                    user1.address,
                    WETH.target
                  )
                )[0]
              );
              expect(round(afterAssetShares)).to.equal(
                beforeUserAssetShares - getAmountFromWei(withdrawnShares)
              );
            });
            it("should revert if user goes below health factor", async () => {
              // user1 borrows token2
              await pool
                .connect(user1)
                .borrow(WBTC.target, scaleAmount(1.5, 8));

              const amount = getAmountInWei(10);
              withdrawnShares = await pool.amountToShares(
                WETH.target,
                amount,
                false
              );
              // user1 tries to withdraw supplied WETH
              await expect(
                pool
                  .connect(user1)
                  .withdraw(WETH.target, amount, getAmountInWei(10000))
              ).to.be.revertedWithCustomError(pool, "BelowHeathFactor");
            });
          });
          describe("redeem()", () => {
            before(async () => {
              // Deploy ERC20 and USD price feeds mocks
              [DAI, WETH, WBTC, daiFeed, wethFeed, wbtcFeed] =
                await deployTokenMocks();

              // Deploy Lending Pool contract
              pool = await deployPool(
                DAI.target,
                daiFeed.target,
                vaultInfoParams
              );

              // unpause pool
              await pool
                .connect(owner)
                .setPausedStatus(ethers.ZeroAddress, false);

              // add supported ERC20 tokens
              await setupTokenVault(
                WETH.target,
                wethFeed.target,
                vaultInfoParams,
                true
              );
              await setupTokenVault(
                WBTC.target,
                wbtcFeed.target,
                vaultInfoParams,
                true
              );

              // user 1 supplies WETH
              await mintERC20(user1, WETH.target, getAmountInWei(80));
              await supply(user1, WETH.target, getAmountInWei(80), pool);
            });
            it("should revert if withdrawn shares are greater than supplied shares", async () => {
              const userAssetShares = getAmountFromWei(
                (
                  await pool.getUserTokenCollateralAndBorrow(
                    user1.address,
                    WETH.target
                  )
                )[0]
              );
              const redeemShares = getAmountInWei(userAssetShares + 100);
              await expect(
                pool.connect(user1).redeem(WETH.target, redeemShares, 0)
              ).to.be.revertedWithCustomError(pool, "InsufficientBalance");
            });
            let beforeUserbalance,
              beforePoolAssetShares,
              beforePoolAssetAmount,
              beforeUserAssetShares,
              withdrawnAmount,
              withdrawnShares;
            it("should allow user to redeem shares", async () => {
              // user 2 supplies token2
              let amount = getAmountInWei(5);
              await mintERC20(user2, WBTC.target, amount);
              await supply(user2, WBTC.target, amount, pool);

              // user2 borrows token 1
              await pool.connect(user2).borrow(WETH.target, getAmountInWei(10));

              // tx stays in mempool for some blocks
              await hre.network.provider.send("hardhat_mine", ["0xa"]);

              const vault = await pool.getTokenVault(WETH.target);
              beforePoolAssetShares = getAmountFromWei(vault.totalAsset.shares);
              beforePoolAssetAmount = getAmountFromWei(vault.totalAsset.amount);
              beforeUserbalance = getAmountFromWei(
                await WETH.balanceOf(user1.address)
              );
              beforeUserAssetShares = getAmountFromWei(
                (
                  await pool.getUserTokenCollateralAndBorrow(
                    user1.address,
                    WETH.target
                  )
                )[0]
              );

              withdrawnShares = getAmountInWei(10);
              withdrawnAmount = await pool.sharesToAmount(
                WETH.target,
                withdrawnShares,
                false
              );

              pool.on("Withdraw", (user, token, repayAmount, repayShares) => {
                expect(user).to.equal(user1.address);
                expect(token).to.equal(WETH.target);
                expect(repayShares).to.equal(withdrawnShares);
                expect(repayAmount).to.greaterThanOrEqual(withdrawnAmount);
              });

              // user1 withdraws 10 ETH
              await expect(
                pool.connect(user1).redeem(WETH.target, withdrawnShares, 0)
              ).to.emit(pool, "Withdraw");
            });
            it("should transfer withdrawn amount to user", async () => {
              const afterUserbalance = getAmountFromWei(
                await WETH.balanceOf(user1.address)
              );
              // received amount is greater because of interest accrued
              expect(afterUserbalance).to.be.greaterThanOrEqual(
                getAmountFromWei(withdrawnAmount) + beforeUserbalance
              );
            });
            it("should update asset shares/amount in the token vault", async () => {
              const vault = await pool.getTokenVault(WETH.target);
              expect(round(getAmountFromWei(vault.totalAsset.amount))).to.equal(
                beforePoolAssetAmount - getAmountFromWei(withdrawnAmount)
              );
              expect(round(getAmountFromWei(vault.totalAsset.shares))).to.equal(
                beforePoolAssetShares - getAmountFromWei(withdrawnShares)
              );
            });
            it("should update user asset balance", async () => {
              const afterAssetShares = getAmountFromWei(
                (
                  await pool.getUserTokenCollateralAndBorrow(
                    user1.address,
                    WETH.target
                  )
                )[0]
              );
              expect(round(afterAssetShares)).to.equal(
                beforeUserAssetShares - getAmountFromWei(withdrawnShares)
              );
            });
            it("should revert if user becomes not solvent", async () => {
              // user1 borrows token2
              await pool.connect(user1).borrow(WBTC.target, scaleAmount(3, 8));
              // user1 tries to withdraw supplied WETH
              await expect(
                pool.connect(user1).redeem(WETH.target, getAmountInWei(30), 0)
              ).to.be.revertedWithCustomError(pool, "BelowHeathFactor");
            });
          });
          describe("liquidate()", () => {
            before(async () => {
              // Deploy ERC20 and USD price feeds mocks
              [DAI, WETH, WBTC, daiFeed, wethFeed, wbtcFeed] =
                await deployTokenMocks();

              // Deploy Lending Pool contract
              pool = await deployPool(
                DAI.target,
                daiFeed.target,
                vaultInfoParams
              );

              // unpause pool
              await pool
                .connect(owner)
                .setPausedStatus(ethers.ZeroAddress, false);

              // add supported ERC20 tokens
              await setupTokenVault(
                WETH.target,
                wethFeed.target,
                vaultInfoParams,
                true
              );
              await setupTokenVault(
                WBTC.target,
                wbtcFeed.target,
                vaultInfoParams,
                true
              );

              // user 1 supplies WETH
              await mintERC20(user1, WETH.target, getAmountInWei(200));
              await supply(user1, WETH.target, getAmountInWei(200), pool);

              // user 2 supplies token2
              const amount = scaleAmount(10, 8);
              await mintERC20(user2, WBTC.target, amount);
              await supply(user2, WBTC.target, amount, pool);

              // user2 borrows token 1
              await pool
                .connect(user2)
                .borrow(WETH.target, getAmountInWei(100));
            });
            it("should revert if borrower is solvent", async () => {
              await expect(
                pool
                  .connect(user1)
                  .liquidate(
                    user2.address,
                    WBTC.target,
                    WETH.target,
                    getAmountInWei(40)
                  )
              ).to.be.revertedWithCustomError(pool, "BorrowerIsSolvant");
            });
            let repaidAmount,
              totalReceivedCollateral,
              beforePoolbalance1,
              beforePoolAssetShares,
              beforePoolAssetAmount,
              beforePoolBorrowShares,
              beforePoolBorrowAmount,
              beforeUserBorrowShares1,
              beforeUserAssetShares2;
            it("should revert borrower try to liquidate his position", async () => {
              // simulate decrease in token2 price
              await wbtcFeed.updateAnswer(scaleAmount(24000, 8)); // 1 BTC = 24000$

              // user2 health factor is less than 1
              expect(await pool.healthFactor(user2.address)).to.be.lessThan(
                getAmountInWei(1)
              );
              const liquidatedAmount = getAmountInWei(50);
              await mintAndapproveERC20(
                user2,
                WETH.target,
                liquidatedAmount,
                pool.target
              );

              await expect(
                pool
                  .connect(user2)
                  .liquidate(
                    user2.address,
                    WBTC.target,
                    WETH.target,
                    liquidatedAmount
                  )
              ).to.be.revertedWithCustomError(pool, "SelfLiquidation");
            });
            it("should allow liquidator to liquidate unsolvant borrower", async () => {
              // simulate decrease in token2 price
              await wbtcFeed.updateAnswer(scaleAmount(24000, 8)); // 1 BTC = 24000$

              // user2 health factor is less than 1
              expect(await pool.healthFactor(user2.address)).to.be.lessThan(
                getAmountInWei(1)
              );
              beforePoolbalance1 = getAmountFromWei(
                await WETH.balanceOf(pool.target)
              );

              let vault = await pool.getTokenVault(WETH.target);
              beforePoolBorrowAmount = getAmountFromWei(
                vault.totalBorrow.amount
              );
              beforePoolBorrowShares = getAmountFromWei(
                vault.totalBorrow.shares
              );

              vault = await pool.getTokenVault(WBTC.target);
              beforePoolAssetAmount = normalizeAmount(
                vault.totalAsset.amount,
                8
              );
              beforePoolAssetShares = normalizeAmount(
                vault.totalAsset.shares,
                8
              );

              const userShares1 = await pool.getUserTokenCollateralAndBorrow(
                user2.address,
                WETH.target
              );
              beforeUserBorrowShares1 = getAmountFromWei(userShares1[1]);
              const userShares2 = await pool.getUserTokenCollateralAndBorrow(
                user2.address,
                WBTC.target
              );
              beforeUserAssetShares2 = normalizeAmount(userShares2[0], 8);

              const liquidatedAmount = getAmountInWei(50);
              await mintAndapproveERC20(
                user3,
                WETH.target,
                liquidatedAmount,
                pool.target
              );

              pool.on(
                "Liquidated",
                (
                  borrower,
                  liquidator,
                  actualLiquidationAmount,
                  liquidatedCollateral
                ) => {
                  expect(borrower).to.equal(user2.address);
                  expect(liquidator).to.equal(user3.address);
                  expect(actualLiquidationAmount).to.lessThanOrEqual(
                    liquidatedAmount
                  );
                  repaidAmount = Number(actualLiquidationAmount);
                  totalReceivedCollateral = Number(liquidatedCollateral);
                }
              );
              await expect(
                pool
                  .connect(user3)
                  .liquidate(
                    user2.address,
                    WBTC.target,
                    WETH.target,
                    liquidatedAmount
                  )
              ).to.emit(pool, "Liquidated");
            });
            it("should transfer repaid tokens to pool", async () => {
              const afterPoolbalance1 = getAmountFromWei(
                await WETH.balanceOf(pool.target)
              );
              expect(afterPoolbalance1).to.be.equal(
                beforePoolbalance1 + getAmountFromWei(repaidAmount)
              );
            });
            it("should transfer liquidated collateral to liquidator", async () => {
              const beforeLiquidatorBalance = 0;
              const afterLiquidatorBalance = normalizeAmount(
                await WBTC.balanceOf(user3.address),
                8
              );
              expect(afterLiquidatorBalance).to.be.equal(
                beforeLiquidatorBalance +
                  normalizeAmount(totalReceivedCollateral, 8)
              );
            });
            it("should update asset shares/amount of the token vault", async () => {
              const vault = await pool.getTokenVault(WBTC.target);

              expect(normalizeAmount(vault.totalAsset.amount, 8)).to.equal(
                beforePoolAssetAmount -
                  normalizeAmount(totalReceivedCollateral, 8)
              );
            });
            it("should update borrow shares/amount of the token vault", async () => {
              const vault = await pool.getTokenVault(WETH.target);

              expect(
                round(getAmountFromWei(vault.totalBorrow.amount))
              ).to.equal(
                beforePoolBorrowAmount - getAmountFromWei(repaidAmount)
              );
            });
            it("should update borrower borrow shares", async () => {
              const afterUserBorrowShares1 = getAmountFromWei(
                (
                  await pool.getUserTokenCollateralAndBorrow(
                    user2.address,
                    WETH.target
                  )
                )[1]
              );
              const repaidShares =
                (getAmountFromWei(repaidAmount) * beforePoolBorrowShares) /
                beforePoolBorrowAmount;

              expect(afterUserBorrowShares1).to.equal(
                beforeUserBorrowShares1 - repaidShares
              );
            });
            it("should update borrower collateral shares", async () => {
              const afterUserAssetShares2 = normalizeAmount(
                (
                  await pool.getUserTokenCollateralAndBorrow(
                    user2.address,
                    WBTC.target
                  )
                )[0],
                8
              );
              const liquidatedCollShares =
                (normalizeAmount(totalReceivedCollateral, 8) *
                  beforePoolAssetShares) /
                beforePoolAssetAmount;
              totalReceivedCollateral *
                expect(afterUserAssetShares2).to.equal(
                  beforeUserAssetShares2 - liquidatedCollShares
                );
            });
          });
        });
        
        describe("Getters functions", () => {
          describe("getUserData()", () => {
            before(async () => {
              // Deploy ERC20 and USD price feeds mocks
              [DAI, WETH, WBTC, daiFeed, wethFeed, wbtcFeed] =
                await deployTokenMocks();

              // Deploy Lending Pool contract
              pool = await deployPool(
                DAI.target,
                daiFeed.target,
                vaultInfoParams
              );

              // unpause pool
              await pool
                .connect(owner)
                .setPausedStatus(ethers.ZeroAddress, false);

              // add supported ERC20 tokens
              await setupTokenVault(
                WETH.target,
                wethFeed.target,
                vaultInfoParams,
                true
              );
              await setupTokenVault(
                WBTC.target,
                wbtcFeed.target,
                vaultInfoParams,
                true
              );

              // user1 supplies WETH
              await mintERC20(user1, WETH.target, getAmountInWei(40)); // 40 ETH
              await supply(user1, WETH.target, getAmountInWei(40), pool);

              // user2 supplies token2
              const amount = scaleAmount(10, 8); // 10 WBTC
              await mintERC20(user2, WBTC.target, amount);
              await supply(user2, WBTC.target, amount, pool);

              // user2 borrows WETH
              await pool.connect(user2).borrow(WETH.target, getAmountInWei(20));

              // virtually mine some blocks
              await hre.network.provider.send("hardhat_mine", ["0xa"]);
              await pool.connect(user1).accrueInterest(WETH.target);
            });
            it("should return correct total collateral and borrow value in USD", async () => {
              // test user2 data
              const [
                totalTokenCollateralValue,
                totalBorrowValue,
              ] = await pool.getUserData(user2.address);

              // user2 has only wBTC as collateral
              const [user2BTCCollShares, user2BTCBorrowShares] =
                await pool.getUserTokenCollateralAndBorrow(
                  user2.address,
                  WBTC.target
                );
              const user2CollValue = await pool.getAmountInUSD(
                WBTC.target,
                user2BTCCollShares
              );
              expect(user2BTCBorrowShares).to.be.equal(0);

              // user2 has only borrowed ETH
              const [user2ETHCollShares, user2ETHBorrowShares] =
                await pool.getUserTokenCollateralAndBorrow(
                  user2.address,
                  WETH.target
                );
              const user2BorrowedValue = await pool.getAmountInUSD(
                WETH.target,
                user2ETHBorrowShares
              );
              expect(user2ETHCollShares).to.be.equal(0);

              expect(totalTokenCollateralValue).to.be.equal(user2CollValue);
              // account for interest accrued
              expect(totalBorrowValue).to.be.greaterThanOrEqual(
                user2BorrowedValue
              );
            });
          });
          describe("healthFactor()", () => {
            before(async () => {
              // Deploy ERC20 and USD price feeds mocks
              [DAI, WETH, WBTC, daiFeed, wethFeed, wbtcFeed] =
                await deployTokenMocks();

              // Deploy Lending Pool contract
              pool = await deployPool(
                DAI.target,
                daiFeed.target,
                vaultInfoParams
              );

              // unpause pool
              await pool
                .connect(owner)
                .setPausedStatus(ethers.ZeroAddress, false);

              // add supported ERC20 tokens
              await setupTokenVault(
                WETH.target,
                wethFeed.target,
                vaultInfoParams,
                true
              );
              await setupTokenVault(
                WBTC.target,
                wbtcFeed.target,
                vaultInfoParams,
                true
              );

              // user1 supplies WETH
              await mintERC20(user1, WETH.target, getAmountInWei(40)); // 40 ETH
              await supply(user1, WETH.target, getAmountInWei(40), pool);

              // user2 supplies token2
              const amount = scaleAmount(10, 8); // 10 WBTC
              await mintERC20(user2, WBTC.target, amount);
              await supply(user2, WBTC.target, amount, pool);

              // user2 borrows WETH
              await pool.connect(user2).borrow(WETH.target, getAmountInWei(20));

              // virtually mine some blocks
              await hre.network.provider.send("hardhat_mine", ["0xa"]);
              await pool.connect(user1).accrueInterest(WETH.target);
            });
            it("should calculate correct health factor for user", async () => {
              // test user2 health factor
              const user2Data = await pool.getUserData(user2.address);
              const totalCollateralValue = Number(user2Data[0] + user2Data[1]);
              const totalBorrowValue = Number(user2Data[2]);
              const expectedHeathFactor =
                (totalCollateralValue * 80000 * 1e18) /
                (100000 * totalBorrowValue);
              let hf = await pool.healthFactor(user2.address);
              expect(Number(hf)).to.be.equal(expectedHeathFactor);

              // user1 has no borrow so HF = 100*1e18
              hf = await pool.healthFactor(user1.address);
              expect(hf).to.be.equal(getAmountInWei(100));
            });
          });
          describe("amountToShares()/sharesToAmount()", () => {
            before(async () => {
              // Deploy ERC20 and USD price feeds mocks
              [DAI, WETH, WBTC, daiFeed, wethFeed, wbtcFeed] =
                await deployTokenMocks();

              // Deploy Lending Pool contract
              pool = await deployPool(
                DAI.target,
                daiFeed.target,
                vaultInfoParams
              );

              // unpause pool
              await pool
                .connect(owner)
                .setPausedStatus(ethers.ZeroAddress, false);

              // add supported ERC20 tokens
              await setupTokenVault(
                WETH.target,
                wethFeed.target,
                vaultInfoParams,
                true
              );
              await setupTokenVault(
                WBTC.target,
                wbtcFeed.target,                
                vaultInfoParams,
                true
              );

              // user1 supplies WETH
              await mintERC20(user1, WETH.target, getAmountInWei(40)); // 40 ETH
              await supply(user1, WETH.target, getAmountInWei(40), pool);

              // user2 supplies token2
              const amount = scaleAmount(10, 8); // 10 WBTC
              await mintERC20(user2, WBTC.target, amount);
              await supply(user2, WBTC.target, amount, pool);

              // user2 borrows WETH
              await pool.connect(user2).borrow(WETH.target, getAmountInWei(20));
            });
            it("should return correct shares given token amount", async () => {
              // virtually mine some blocks
              await hre.network.provider.send("hardhat_mine", ["0xa"]);
              await pool.connect(user1).accrueInterest(WETH.target);

              // test for ETH asset vault shares
              const ethamount = getAmountInWei(5);
              const vault = await pool.getTokenVault(WETH.target);
              const expectedAssetShares =
                (ethamount * vault.totalAsset.shares) / vault.totalAsset.amount;
              let shares = await pool.amountToShares(
                WETH.target,
                ethamount,
                true // asset
              );
              expect(shares).to.be.equal(expectedAssetShares);

              // test for ETH borrow vault shares
              const expectedBorrowShares =
                (ethamount * vault.totalBorrow.shares) /
                vault.totalBorrow.amount;
              shares = await pool.amountToShares(WETH.target, ethamount, false);
              expect(shares).to.be.equal(expectedBorrowShares);

              // test for BTC asset vault shares
              const btcamount = scaleAmount(5, 8); // 5 WBTC
              const vaultBTC = await pool.getTokenVault(WETH.target);
              const expectedBTCAssetShares =
                (btcamount * Number(vaultBTC.totalAsset.shares)) /
                Number(vaultBTC.totalAsset.amount);
              shares = await pool.amountToShares(
                WETH.target,
                btcamount,
                true // asset
              );
              expect(Number(shares)).to.be.equal(
                Math.floor(expectedBTCAssetShares)
              );
            });
            it("should return correct amount given vault shares", async () => {
              // test for ETH asset vault amount
              const ethShares = getAmountInWei(10);
              const vault = await pool.getTokenVault(WETH.target);
              const expectedAssetAmount =
                (ethShares * vault.totalAsset.amount) / vault.totalAsset.shares;
              let amount = await pool.sharesToAmount(
                WETH.target,
                ethShares,
                true // asset
              );
              expect(amount).to.be.equal(expectedAssetAmount);

              // test for ETH borrow vault amount
              const expectedBorrowAmount =
                (ethShares * vault.totalBorrow.amount) /
                vault.totalBorrow.shares;
              amount = await pool.sharesToAmount(WETH.target, ethShares, false);
              expect(amount).to.be.equal(expectedBorrowAmount);

              // test for BTC asset vault amount
              const btcShares = scaleAmount(5, 8); // 5 WBTC
              const vaultBTC = await pool.getTokenVault(WETH.target);
              const expectedBTCAmount =
                (btcShares * Number(vaultBTC.totalAsset.amount)) /
                Number(vaultBTC.totalAsset.shares);
              amount = await pool.sharesToAmount(
                WETH.target,
                btcShares,
                true // asset
              );
              expect(Number(amount)).to.be.equal(Math.floor(expectedBTCAmount));
            });
          });
          describe("getPrice()", () => {
            before(async () => {
              // Deploy ERC20 and USD price feeds mocks
              [DAI, WETH, WBTC, daiFeed, wethFeed, wbtcFeed] =
                await deployTokenMocks();

              // Deploy Lending Pool contract
              pool = await deployPool(
                DAI.target,
                daiFeed.target,
                vaultInfoParams
              );

              // unpause pool
              await pool
                .connect(owner)
                .setPausedStatus(ethers.ZeroAddress, false);

              // add supported ERC20 tokens
              await setupTokenVault(
                WETH.target,
                wethFeed.target,
                vaultInfoParams,
                true
              );
              await setupTokenVault(
                WBTC.target,
                wbtcFeed.target,
                vaultInfoParams,
                true
              );
            });
            it("should return correct price", async () => {
              const price1 = await pool.getTokenPrice(WETH.target);
              let expected_price1 = (await wethFeed.latestRoundData())[1];
              expected_price1 = scaleAmount(expected_price1, 10); // scale by 10^10
              expect(Number(price1)).to.be.equal(expected_price1);

              const price2 = await pool.getTokenPrice(WBTC.target);
              let expected_price2 = (await wbtcFeed.latestRoundData())[1];
              expected_price2 = scaleAmount(expected_price2, 10); // scale by 10^10
              expect(Number(price2)).to.be.equal(expected_price2);
            });
            it("should return price scaled by 18 decimals", async () => {
              const token = await deployERC20Mock("USD coinbase", "USDC", 6);
              const tokenFeed = await deployAggregatorMock(
                scaleAmount(1, 8),
                8
              ); // 1USDC = 1$
              await setupTokenVault(
                token.target,
                tokenFeed.target,
                vaultInfoParams,
                true
              );
              let price = await pool.getTokenPrice(token.target);
              const expected_price = getAmountInWei(1); // 1e18
              expect(price).to.be.equal(expected_price);
            });
            it("should return zero price if token is not supported", async () => {
              const token3 = await deployERC20Mock("USDT", "USDT", 6);
              const price = await pool.getTokenPrice(token3.target);
              expect(price).to.be.equal(0);
            });
            it("should revert if price is outdated", async () => {
              const period = 3 * 24 * 3600; // 3h
              await moveTime(period);
              await expect(
                pool.getTokenPrice(WETH.target)
              ).to.be.revertedWithCustomError(pool, "InvalidPrice");
            });
            it("should revert if price is below zero", async () => {
              await wethFeed.updateAnswer(0);
              await expect(
                pool.getTokenPrice(WETH.target)
              ).to.be.revertedWithCustomError(pool, "InvalidPrice");
            });
          });
          describe("getAmountInUSD()", () => {
            before(async () => {
              // Deploy ERC20 and USD price feeds mocks
              [DAI, WETH, WBTC, daiFeed, wethFeed, wbtcFeed] =
                await deployTokenMocks();

              // Deploy Lending Pool contract
              pool = await deployPool(
                DAI.target,
                daiFeed.target,
                vaultInfoParams
              );

              // unpause pool
              await pool
                .connect(owner)
                .setPausedStatus(ethers.ZeroAddress, false);

              // add supported ERC20 tokens
              await setupTokenVault(
                WETH.target,
                wethFeed.target,
                vaultInfoParams,
                true
              );
              await setupTokenVault(
                WBTC.target,
                wbtcFeed.target,
                vaultInfoParams,
                true
              );
            });
            it("should return correct amount in USD", async () => {
              const ethAmount = getAmountInWei(10); // 10 ETH
              const ethToUSDAmount = await pool.getAmountInUSD(
                WETH.target,
                ethAmount
              );
              let price1 = (await wethFeed.latestRoundData())[1];
              scaled_price1 = scaleAmount(Number(price1), 10); // scale by 10^10
              const expectedUsdAmount1 = scaled_price1 * 10;
              expect(Number(ethToUSDAmount)).to.be.equal(expectedUsdAmount1);

              const wbtcAmount = getAmountInWei(5); // 5 BTC
              const wbtcToUSDAmount = await pool.getAmountInUSD(
                WETH.target,
                wbtcAmount
              );
              let price2 = (await wethFeed.latestRoundData())[1];
              scaled_price2 = scaleAmount(Number(price2), 10); // scale by 10^10
              const expectedUsdAmount2 = scaled_price2 * 5;
              expect(Number(wbtcToUSDAmount)).to.be.equal(expectedUsdAmount2);
            });
          });
        });
      });

      describe("Admin Functions", () => {
        before(async () => {
          // Deploy ERC20 and USD price feeds mocks
          [DAI, WETH, WBTC, daiFeed, wethFeed, wbtcFeed] =
            await deployTokenMocks();

          // Deploy Lending Pool contract
          pool = await deployPool(DAI.target, daiFeed.target, vaultInfoParams);
        });
        it("only owner should be allowed to change pool paused status", async () => {
          expect(await pool.pausedStatus(ethers.ZeroAddress)).to.equal(true);
          // Non owner tries to unpause
          await expect(
            pool.connect(randomUser).setPausedStatus(ethers.ZeroAddress, false)
          ).to.be.revertedWith("Ownable: caller is not the owner");
          // owner unpause pool
          await pool.connect(owner).setPausedStatus(ethers.ZeroAddress, false);
          expect(await pool.pausedStatus(ethers.ZeroAddress)).to.equal(false);
        });
        it("only owner should be allowed to add new supported tokens", async () => {
          // Deploy ERC20 mocks contract for testing
          const WETH = await deployERC20Mock("ether", "ETH", 18);
          const wethFeed = await deployAggregatorMock(scaleAmount(2000, 8), 8); // 1ETH = 2000$
          // Non owner tries to add new token
          await expect(
            pool
              .connect(randomUser)
              .setupVault(
                WETH.target,
                wethFeed.target,
                vaultInfoParams,
                true
              )
          ).to.be.revertedWith("Ownable: caller is not the owner");
          // owner add new supported token
          await pool
            .connect(owner)
            .setupVault(
              WETH.target,
              wethFeed.target,
              vaultInfoParams,
              true
            );
        });
        it("should not be able to setup vault when it isn't paused", async () => {
          // Deploy ERC20 mocks contract for testing
          const WETH = await deployERC20Mock("ether", "ETH", 18);
          const wethFeed = await deployAggregatorMock(scaleAmount(2000, 8), 8); // 1ETH = 2000$
          // owner tries to setup vault when it's not paused
          await pool.connect(owner).setPausedStatus(WETH.target, false);
          await expect(
            pool
              .connect(owner)
              .setupVault(
                WETH.target,
                wethFeed.target,
                vaultInfoParams,
                false
              )
          ).to.be.revertedWithCustomError(pool, "isNotPaused");
        });
        it("only owner should be able to setup pool vaults", async () => {
          // Deploy ERC20 mocks contract for testing
          const WETH = await deployERC20Mock("ether", "ETH", 18);
          const wethFeed = await deployAggregatorMock(scaleAmount(2000, 8), 8); // 1ETH = 2000$

          // pause vault
          await pool.connect(owner).setPausedStatus(WETH.target, true);

          // Non owner tries to setup vault
          await expect(
            pool
              .connect(randomUser)
              .setupVault(
                WETH.target,
                wethFeed.target,
                vaultInfoParams,
                false
              )
          ).to.be.revertedWith("Ownable: caller is not the owner");
          // owner can setup token vault
          await pool
            .connect(owner)
            .setupVault(
              WETH.target,
              wethFeed.target,
              vaultInfoParams,
              false
            );
        });
      });
    });

async function setupTokenVault(
  token,
  tokenPriceFeed,
  vaultInfoParams,
  addToken
) {
  await pool
    .connect(owner)
    .setupVault(token, tokenPriceFeed, vaultInfoParams, addToken);
}

async function deployPool(daiAddress, daiPriceFeed, daiVaultParams) {
  const pool = await ethers.deployContract("LendingPool", [
    daiAddress,
    daiPriceFeed,
    daiVaultParams,
  ]);
  await pool.waitForDeployment();
  return pool;
}

async function deployTokenMocks() {
  // Deploy ERC20 mocks contract for testing
  const DAI = await deployERC20Mock("dai", "DAI", 18);
  const WETH = await deployERC20Mock("ether", "ETH", 18);
  const WBTC = await deployERC20Mock("wrapped Bitcoin", "wBTC", 8);

  // Deploy chainlink USD price feed mocks
  const daiFeed = await deployAggregatorMock(scaleAmount(1, 8), 8); // 1DAI = 1$
  const wethFeed = await deployAggregatorMock(scaleAmount(2000, 8), 8); // 1ETH = 2000$
  const wbtcFeed = await deployAggregatorMock(scaleAmount(30000, 8), 8); // 1BTC = 30000$

  return [DAI, WETH, WBTC, daiFeed, wethFeed, wbtcFeed];
}

async function supply(user, tokenAddress, amount, pool) {
  await approveERC20(user, tokenAddress, amount, pool.target);
  const tx = await pool.connect(user).supply(tokenAddress, amount, 0);
  let txReceipt = await tx.wait(1);

  return txReceipt;
}
