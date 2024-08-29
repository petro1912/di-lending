// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {VaultAccounting} from "./libraries/VaultAccounting.sol";
import {TokenSupport} from "./TokenSupport.sol";
import {PoolStructs} from "./interfaces/PoolStructs.sol";
import {InterestRate} from "./libraries/InterestRate.sol";
import {Pausable} from "./utils/Pausable.sol";
import "./libraries/TokenHelper.sol";

/**
 * @title An ERC20 lending pool in CrossFi Chain
 * @author Petro1912
 * @notice This contract implements a lending and borrowing protocol with support for ERC20 collateral.
 * @dev This contract will be owned by the governance who is the only address allowed to: add new vaults, change existing vault setup, pause pool or specific vault.
 */
contract LendingPool is Pausable, TokenSupport {
    using VaultAccounting for PoolStructs.Vault;
    using InterestRate for PoolStructs.VaultInfo;
    using TokenHelper for address;

    //--------------------------------------------------------------------
    /** VARIABLES */

    // ERC20 token => TokenVault
    mapping(address => PoolStructs.TokenVault) private vaults;
    // user => token => (colletral, borrow) shares
    mapping(address => mapping(address => PoolStructs.AccountShares))
        private userShares;
    
    //--------------------------------------------------------------------
    /** ERRORS */

    error TooHighSlippage(uint256 sharesOutOrAmountIn);
    error InsufficientBalance();
    error BelowHeathFactor();
    error BorrowerIsSolvant();
    error SelfLiquidation();
    error InvalidFeeRate(uint256 fee);
    error InvalidReserveRatio(uint256 ratio);
    error NoLiquidateWarn();
    error WarningDelayHasNotPassed();
    error MustRepayMoreDebt();
    error LiquidatorDelayHasNotPassed();
    error EmptyArray();
    error ArrayMismatch();

    //--------------------------------------------------------------------
    /** EVENTS */

    event Deposit(address user, address token, uint256 amount, uint256 shares);
    event Borrow(address user, address token, uint256 amount, uint256 shares);
    event Repay(address user, address token, uint256 amount, uint256 shares);
    event Withdraw(address user, address token, uint256 amount, uint256 shares);
    event Liquidated(
        address borrower,
        address liquidator,
        uint256 repaidAmount,
        uint256 liquidatedCollateral,
        uint256 reward
    );
    event UpdateInterestRate(uint256 elapsedTime, uint64 newInterestRate);
    event AccruedInterest(
        uint64 interestRatePerSec,
        uint256 interestEarned,
        uint256 feesAmount,
        uint256 feesShare
    );
    event NewVaultSetup(address token, PoolStructs.VaultSetupParams params);

    //--------------------------------------------------------------------
    /** Constructor */

    /**
     * @notice Sets the first vault using DAI.
     * @param daiAddress DAI token address.
     * @param daiPriceFeed The address of DAI/USD price feed contract .
     * @param daiVaultParams The parameters for DAI token vault (see PoolStructs.VaultSetupParams).
     */
    constructor(
        address daiAddress,
        address daiPriceFeed,
        PoolStructs.VaultSetupParams memory daiVaultParams
    ) {
        _setupVault(
            daiAddress,
            daiPriceFeed,
            daiVaultParams,
            true
        );
    }

    /*//////////////////////////////////////////////////////////////
                        ERC20 Logic functions
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Allows users to supply ERC20 tokens to the pool.
     * @dev only supported ERC20 are allowed.
     * @dev pool or token vault must not be paused.
     * @param token The ERC20 token address.
     * @param amount The amount of tokens to supply.
     * @param minSharesOut The minimum shares to be receive.
     */
    function supply(
        address token,
        uint256 amount,
        uint256 minSharesOut
    ) external {
        WhenNotPaused(token);
        allowedToken(token);
        _accrueInterest(token);

        token.transferERC20(msg.sender, address(this), amount);
        uint256 shares = vaults[token].totalAsset.toShares(amount, false);
        if (shares < minSharesOut) revert TooHighSlippage(shares);

        vaults[token].totalAsset.shares += uint128(shares);
        vaults[token].totalAsset.amount += uint128(amount);
        userShares[msg.sender][token].collateral += shares;

        emit Deposit(msg.sender, token, amount, shares);
    }

    /**
     * @notice Allows users to borrow ERC20 tokens from the pool.
     * @dev pool or token vault must not be paused.
     * @dev will revert if pool goes below reserve ratio.
     * @param token The ERC20 token address.
     * @param amount The amount of tokens to borrow.
     */
    function borrow(address token, uint256 amount) external {
        WhenNotPaused(token);
        if (!vaultAboveReserveRatio(token, amount))
            revert InsufficientBalance();
        _accrueInterest(token);

        uint256 shares = vaults[token].totalBorrow.toShares(amount, false);
        vaults[token].totalBorrow.shares += uint128(shares);
        vaults[token].totalBorrow.amount += uint128(amount);
        userShares[msg.sender][token].borrow += shares;

        token.transferERC20(address(this), msg.sender, amount);
        if (healthFactor(msg.sender) < MIN_HEALTH_FACTOR)
            revert BelowHeathFactor();

        emit Borrow(msg.sender, token, amount, shares);
    }

    /**
     * @notice Allows users to repay borrowed ERC20 tokens to the pool.
     * @param token The ERC20 token address.
     * @param amount The amount of tokens to repay, set to type(uint256).max for full repayment.
     */
    function repay(address token, uint256 amount) external {
        _accrueInterest(token);
        uint256 userBorrowShare = userShares[msg.sender][token].borrow;
        uint256 shares = vaults[token].totalBorrow.toShares(amount, true);
        if (amount == type(uint256).max || shares > userBorrowShare) {
            shares = userBorrowShare;
            amount = vaults[token].totalBorrow.toAmount(shares, true);
        }
        token.transferERC20(msg.sender, address(this), amount);
        unchecked {
            vaults[token].totalBorrow.shares -= uint128(shares);
            vaults[token].totalBorrow.amount -= uint128(amount);
            userShares[msg.sender][token].borrow = userBorrowShare - shares;
        }
        emit Repay(msg.sender, token, amount, shares);
    }

    /**
     * @notice Allows users to withdraw supplied ERC20 tokens.
     * @param token The ERC20 token address.
     * @param amount The amount of tokens to withdraw.
     * @param maxSharesIn The maximum shares to be redeemed for the desired withdraw amount, used as slippage protection.
     */
    function withdraw(
        address token,
        uint256 amount,
        uint256 maxSharesIn
    ) external {
        _withdraw(token, amount, maxSharesIn, false);
    }

    /**
     * @notice Redeems shares for ERC20 tokens from the lending pool.
     * @param token The ERC20 token address.
     * @param shares The amount of shares to redeem.
     * @param minAmountOut The minimum amount to be received for the shares redeemed, used as slippage protection.
     */
    function redeem(
        address token,
        uint256 shares,
        uint256 minAmountOut
    ) external {
        _withdraw(token, shares, minAmountOut, true);
    }

    /**
     * @notice Allows users to liquidate unsolvent borrower.
     * @dev borrower must be below min HF.
     * @dev full liquidation is only allowed if borrower HF is below ´CLOSE_FACTOR_HF_THRESHOLD´ otherwise can only repay uo to 50% of borrower debts.
     * @param account The borrower's address.
     * @param collateral The collateral asset address.
     * @param userBorrowToken The token the borrower has borrowed.
     * @param amountToLiquidate The amount to liquidate.
     */
    function liquidate(
        address account,
        address collateral,
        address userBorrowToken,
        uint256 amountToLiquidate
    ) external {
        if (msg.sender == account) revert SelfLiquidation();
        uint256 accountHF = healthFactor(account);
        if (accountHF >= MIN_HEALTH_FACTOR) revert BorrowerIsSolvant();

        uint256 collateralShares = userShares[account][collateral].collateral;
        uint256 borrowShares = userShares[account][userBorrowToken].borrow;
        if (collateralShares == 0 || borrowShares == 0) return;
        {
            uint256 totalBorrowAmount = vaults[userBorrowToken]
                .totalBorrow
                .toAmount(borrowShares, true);

            // if HF is above CLOSE_FACTOR_HF_THRESHOLD allow only partial liquidation
            // else full liquidation is possible
            uint256 maxBorrowAmountToLiquidate = accountHF >=
                CLOSE_FACTOR_HF_THRESHOLD
                ? (totalBorrowAmount * DEFAULT_LIQUIDATION_CLOSE_FACTOR) / BPS
                : totalBorrowAmount;
            amountToLiquidate = amountToLiquidate > maxBorrowAmountToLiquidate
                ? maxBorrowAmountToLiquidate
                : amountToLiquidate;
        }

        uint256 collateralAmountToLiquidate;
        uint256 liquidationReward;
        {
            // avoid stack too deep error
            address user = account;
            address borrowToken = userBorrowToken;
            address collToken = collateral;
            uint256 liquidationAmount = amountToLiquidate;

            uint256 _userTotalCollateralAmount = vaults[collToken]
                .totalAsset
                .toAmount(collateralShares, false);

            uint256 collateralPrice = getTokenPrice(collToken);
            uint256 borrowTokenPrice = getTokenPrice(borrowToken);
            uint8 collateralDecimals = collToken.tokenDecimals();
            uint8 borrowTokenDecimals = borrowToken.tokenDecimals();

            collateralAmountToLiquidate =
                (liquidationAmount *
                    borrowTokenPrice *
                    10 ** collateralDecimals) /
                (collateralPrice * 10 ** borrowTokenDecimals);
            uint256 maxLiquidationReward = (collateralAmountToLiquidate *
                LIQUIDATION_REWARD) / BPS;
            if (collateralAmountToLiquidate > _userTotalCollateralAmount) {
                collateralAmountToLiquidate = _userTotalCollateralAmount;
                liquidationAmount =
                    ((_userTotalCollateralAmount *
                        collateralPrice *
                        10 ** borrowTokenDecimals) / borrowTokenPrice) *
                    10 ** collateralDecimals;
                amountToLiquidate = liquidationAmount;
            } else {
                uint256 collateralBalanceAfter = _userTotalCollateralAmount -
                    collateralAmountToLiquidate;
                liquidationReward = maxLiquidationReward >
                    collateralBalanceAfter
                    ? collateralBalanceAfter
                    : maxLiquidationReward;
            }

            // Update borrow vault
            uint128 repaidBorrowShares = uint128(
                vaults[borrowToken].totalBorrow.toShares(
                    liquidationAmount,
                    false
                )
            );
            vaults[borrowToken].totalBorrow.shares -= repaidBorrowShares;
            vaults[borrowToken].totalBorrow.amount -= uint128(
                liquidationAmount
            );

            // Update collateral vault
            uint128 liquidatedCollShares = uint128(
                vaults[collToken].totalAsset.toShares(
                    collateralAmountToLiquidate + liquidationReward,
                    false
                )
            );
            vaults[collToken].totalAsset.shares -= liquidatedCollShares;
            vaults[collToken].totalAsset.amount -= uint128(
                collateralAmountToLiquidate + liquidationReward
            );
            // Update borrower collateral and borrow shares
            userShares[user][borrowToken].borrow -= repaidBorrowShares;
            userShares[user][collToken].collateral -= liquidatedCollShares;
        }

        // Repay borrowed amount
        userBorrowToken.transferERC20(
            msg.sender,
            address(this),
            amountToLiquidate
        );
        // Transfer collateral & liquidation reward to liquidator
        collateral.transferERC20(
            address(this),
            msg.sender,
            collateralAmountToLiquidate + liquidationReward
        );

        emit Liquidated(
            account,
            msg.sender,
            amountToLiquidate,
            collateralAmountToLiquidate + liquidationReward,
            liquidationReward
        );
    }

    /**
     * @notice Accrue interest for a specific ERC20 token.
     * @param token The ERC20 token address.
     * @return _interestEarned The interest earned.
     * @return _feesAmount The fees amount accrued for the protocol.
     * @return _feesShare The fees shares accrued for the protocol.
     * @return _newRate The new interest rate.
     */
    function accrueInterest(
        address token
    )
        external
        returns (
            uint256 _interestEarned,
            uint256 _feesAmount,
            uint256 _feesShare,
            uint64 _newRate
        )
    {
        return _accrueInterest(token);
    }

    
    /*//////////////////////////////////////////////////////////////
                        Getters functions
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev Returns the total tokens collateral, and total borrowed values in USD for a user.
     * @param user The address of the user.
     */
    function getUserData(
        address user
    )
        public
        view
        returns (
            uint256 totalTokenCollateral,
            uint256 totalBorrowValue
        )
    {
        totalTokenCollateral = getUserTotalTokenCollateral(user);
        totalBorrowValue = getUserTotalBorrow(user);
    }

    /**
     * @dev Calculates the total USD value of all tokens collateral for a user.
     * @param user The address of the user.
     */
    function getUserTotalTokenCollateral(
        address user
    ) public view returns (uint256 totalValueUSD) {
        uint256 len = supportedERC20s.length;
        for (uint256 i; i < len; ) {
            address token = supportedERC20s[i];
            uint256 tokenAmount = vaults[token].totalAsset.toAmount(
                userShares[user][token].collateral,
                false
            );
            if (tokenAmount != 0) {
                totalValueUSD += getAmountInUSD(token, tokenAmount);
            }
            unchecked {
                ++i;
            }
        }
    }

    /**
     * @dev Calculates the total borrowed USD value for a user.
     * @param user The address of the user.
     */
    function getUserTotalBorrow(
        address user
    ) public view returns (uint256 totalValueUSD) {
        uint256 len = supportedERC20s.length;
        for (uint256 i; i < len; ) {
            address token = supportedERC20s[i];
            uint256 tokenAmount = vaults[token].totalBorrow.toAmount(
                userShares[user][token].borrow,
                false
            );
            if (tokenAmount != 0) {
                totalValueUSD += getAmountInUSD(token, tokenAmount);
            }
            unchecked {
                ++i;
            }
        }
    }

    /**
     * @dev Returns the collateral and borrow shares for a specific token and user.
     * @param user The address of the user.
     * @param token The address of the token.
     */
    function getUserTokenCollateralAndBorrow(
        address user,
        address token
    )
        external
        view
        returns (uint256 tokenCollateralShare, uint256 tokenBorrowShare)
    {
        tokenCollateralShare = userShares[user][token].collateral;
        tokenBorrowShare = userShares[user][token].borrow;
    }

    /**
     * @dev Calculates the health factor of a user.
     * @param user The address of the user.
     */
    function healthFactor(address user) public view returns (uint256 factor) {
        (
            uint256 totalTokenCollateral,
            uint256 totalBorrowValue
        ) = getUserData(user);

        if (totalBorrowValue == 0) return 100 * MIN_HEALTH_FACTOR;
        uint256 collateralValueWithThreshold = (totalTokenCollateral * LIQUIDATION_THRESHOLD) / BPS;
        factor =
            (collateralValueWithThreshold * MIN_HEALTH_FACTOR) /
            totalBorrowValue;
    }

    /**
     * @dev Converts the given amount of a token to its equivalent value in USD.
     * @param token The address of the token.
     * @param amount The amount of the token.
     */
    function getAmountInUSD(
        address token,
        uint256 amount
    ) public view returns (uint256 value) {
        uint256 price = getTokenPrice(token);
        uint8 decimals = token.tokenDecimals();
        uint256 amountIn18Decimals = amount * 10 ** (18 - decimals);
        // return USD value scaled by 18 decimals
        value = (amountIn18Decimals * price) / PRECISION;
    }

    /**
     * @dev Obtain all informations about the token vault.
     * @param token The address of the token.
     */
    function getTokenVault(
        address token
    ) public view returns (PoolStructs.TokenVault memory vault) {
        vault = vaults[token];
    }

    /**
     * @dev Converts the given amount of a token to its equivalent shares.
     * @param token The address of the token.
     * @param amount The amount of the token.
     * @param isAsset Boolean indicating whether the amount is asset or borrow.
     */

    function amountToShares(
        address token,
        uint256 amount,
        bool isAsset
    ) external view returns (uint256 shares) {
        if (isAsset) {
            shares = uint256(vaults[token].totalAsset.toShares(amount, false));
        } else {
            shares = uint256(vaults[token].totalBorrow.toShares(amount, false));
        }
    }

    /**
     * @dev Converts the given shares of a token to its equivalent amount.
     * @param token The address of the token.
     * @param shares The shares of the token.
     * @param isAsset Boolean indicating whether the amount is asset or borrow.
     */
    function sharesToAmount(
        address token,
        uint256 shares,
        bool isAsset
    ) external view returns (uint256 amount) {
        if (isAsset) {
            amount = uint256(vaults[token].totalAsset.toAmount(shares, false));
        } else {
            amount = uint256(vaults[token].totalBorrow.toAmount(shares, false));
        }
    }

    /*//////////////////////////////////////////////////////////////
                            Owner functions
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Sets up the vault for a specified ERC20 token.
     * @dev only called by the owner.
     * @param token The ERC20 token address.
     * @param priceFeed The address of the price feed contract for the token.
     * @param params The parameters for vault setup (see PoolStructs.VaultSetupParams).
     * @param addToken Boolean indicating whether to add a new supported token or just change the setup of an already added token.
     */
    function setupVault(
        address token,
        address priceFeed,
        PoolStructs.VaultSetupParams memory params,
        bool addToken
    ) external onlyOwner {
        _setupVault(token, priceFeed, params, addToken);
    }

    //--------------------------------------------------------------------
    /** INTERNAL FUNCTIONS */

    /**
     * @dev Checks if a specific token vault has sufficient balance and is above the reserve ratio.
     * @param token The ERC20 token address.
     * @param pulledAmount The amount to pull from the vault.
     * @return isAboveReserveRatio True if the vault has sufficient balance, otherwise false.
     */
    function vaultAboveReserveRatio(
        address token,
        uint256 pulledAmount
    ) internal view returns (bool isAboveReserveRatio) {
        uint256 minVaultReserve = (vaults[token].totalAsset.amount *
            vaults[token].vaultInfo.reserveRatio) / BPS;
        isAboveReserveRatio =
            vaults[token].totalAsset.amount != 0 &&
            IERC20(token).balanceOf(address(this)) >=
            minVaultReserve + pulledAmount;
    }

    function _withdraw(
        address token,
        uint256 amount,
        uint256 minAmountOutOrMaxShareIn,
        bool share
    ) internal {
        _accrueInterest(token);

        uint256 userCollShares = userShares[msg.sender][token].collateral;
        uint256 shares;
        if (share) {
            // redeem shares
            shares = amount;
            amount = vaults[token].totalAsset.toAmount(shares, false);
            if (amount < minAmountOutOrMaxShareIn)
                revert TooHighSlippage(amount);
        } else {
            // withdraw amount
            shares = vaults[token].totalAsset.toShares(amount, false);
            if (shares > minAmountOutOrMaxShareIn)
                revert TooHighSlippage(shares);
        }
        if (
            userCollShares < shares ||
            IERC20(token).balanceOf(address(this)) < amount
        ) revert InsufficientBalance();
        unchecked {
            vaults[token].totalAsset.shares -= uint128(shares);
            vaults[token].totalAsset.amount -= uint128(amount);
            userShares[msg.sender][token].collateral -= shares;
        }

        token.transferERC20(address(this), msg.sender, amount);
        if (healthFactor(msg.sender) < MIN_HEALTH_FACTOR)
            revert BelowHeathFactor();
        emit Withdraw(msg.sender, token, amount, shares);
    }

    function _accrueInterest(
        address token
    )
        internal
        returns (
            uint256 _interestEarned,
            uint256 _feesAmount,
            uint256 _feesShare,
            uint64 newRate
        )
    {
        PoolStructs.TokenVault memory _vault = vaults[token];
        if (_vault.totalAsset.amount == 0) {
            return (0, 0, 0, 0);
        }

        // Add interest only once per block
        PoolStructs.VaultInfo memory _currentRateInfo = _vault.vaultInfo;
        if (_currentRateInfo.lastTimestamp == block.timestamp) {
            newRate = _currentRateInfo.ratePerSec;
            return (_interestEarned, _feesAmount, _feesShare, newRate);
        }

        // If there are no borrows or vault or system is paused, no interest accrues
        if (_vault.totalBorrow.shares == 0 || pausedStatus(token)) {
            _currentRateInfo.lastTimestamp = uint64(block.timestamp);
            _currentRateInfo.lastBlock = uint64(block.number);
            _vault.vaultInfo = _currentRateInfo;
        } else {
            uint256 _deltaTime = block.number - _currentRateInfo.lastBlock;
            uint256 _utilization = (_vault.totalBorrow.amount * PRECISION) /
                _vault.totalAsset.amount;
            // Calculate new interest rate
            uint256 _newRate = _currentRateInfo.calculateInterestRate(
                _utilization
            );
            _currentRateInfo.ratePerSec = uint64(_newRate);
            _currentRateInfo.lastTimestamp = uint64(block.timestamp);
            _currentRateInfo.lastBlock = uint64(block.number);

            emit UpdateInterestRate(_deltaTime, uint64(_newRate));

            // Calculate interest accrued
            _interestEarned =
                (_deltaTime *
                    _vault.totalBorrow.amount *
                    _currentRateInfo.ratePerSec) /
                (PRECISION * BLOCKS_PER_YEAR);

            // Accumulate interest and fees
            _vault.totalBorrow.amount += uint128(_interestEarned);
            _vault.totalAsset.amount += uint128(_interestEarned);
            _vault.vaultInfo = _currentRateInfo;
            if (_currentRateInfo.feeToProtocolRate > 0) {
                _feesAmount =
                    (_interestEarned * _currentRateInfo.feeToProtocolRate) /
                    BPS;
                _feesShare =
                    (_feesAmount * _vault.totalAsset.shares) /
                    (_vault.totalAsset.amount - _feesAmount);
                _vault.totalAsset.shares += uint128(_feesShare);

                // accrue protocol fee shares to this contract
                userShares[address(this)][token].collateral += _feesShare;
            }
            emit AccruedInterest(
                _currentRateInfo.ratePerSec,
                _interestEarned,
                _feesAmount,
                _feesShare
            );
        }
        // save to storage
        vaults[token] = _vault;
    }

    function _setupVault(
        address token,
        address priceFeed,
        PoolStructs.VaultSetupParams memory params,
        bool addToken
    ) internal {
        if (addToken) {
            addSupportedToken(token, priceFeed);
        } else {
            // cannot change vault setup when nor system or vault are paused
            WhenPaused(token);
        }
        
        if (params.reserveRatio > BPS)
            revert InvalidReserveRatio(params.reserveRatio);
        if (params.feeToProtocolRate > MAX_PROTOCOL_FEE)
            revert InvalidFeeRate(params.feeToProtocolRate);

        PoolStructs.VaultInfo storage _vaultInfo = vaults[token].vaultInfo;
        _vaultInfo.reserveRatio = params.reserveRatio;
        _vaultInfo.feeToProtocolRate = params.feeToProtocolRate;
        _vaultInfo.optimalUtilization = params.optimalUtilization;
        _vaultInfo.baseRate = params.baseRate;
        _vaultInfo.slope1 = params.slope1;
        _vaultInfo.slope2 = params.slope2;

        emit NewVaultSetup(token, params);
        
    }
}
