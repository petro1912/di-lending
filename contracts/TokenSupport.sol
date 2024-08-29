// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";
import "./libraries/ChainlinkOracle.sol";
import "./utils/Constants.sol";
import "./interfaces/PoolStructs.sol";

/**
 * @title Lending Pool Token Support
 * @dev used to add new supported ERC20 or ERC721 tokens to the lending pool, will give access to the chainlink USD price feeds.
 */
contract TokenSupport is Constants {
    using ChainlinkOracle for AggregatorV3Interface;

    //--------------------------------------------------------------------
    /** VARIABLES */

    // list of all supported ERC20 tokens
    address[] internal supportedERC20s;
    // token => SupportedToken
    mapping(address => PoolStructs.SupportedToken) internal supportedTokens;

    //--------------------------------------------------------------------
    /** ERRORS */

    error TokenNotSupported();
    error AlreadySupported(address token);

    //--------------------------------------------------------------------
    /** EVENTS */

    event AddSupportedToken(address token);

    //--------------------------------------------------------------------
    /** FUNCTIONS */

    /**
     * @dev Adds support for a new ERC20 or ERC721 token.
     * @param token The address of the token.
     * @param priceFeed The address of the Chainlink price feed.
     */
    function addSupportedToken(
        address token,
        address priceFeed
    ) internal {
        if (supportedTokens[token].supported) revert AlreadySupported(token);

        supportedTokens[token].usdPriceFeed = priceFeed;
        supportedTokens[token].supported = true;

        supportedERC20s.push(token);

        emit AddSupportedToken(token);
    }

    /**
     * @dev Gets the USD price of a supported token using Chainlink Oracle.
     * @param token The address of the token.
     */
    function getTokenPrice(address token) public view returns (uint256 price) {
        if (!supportedTokens[token].supported) return 0;
        AggregatorV3Interface priceFeed = AggregatorV3Interface(
            supportedTokens[token].usdPriceFeed
        );
        price = priceFeed.getPrice();
    }

    //--------------------------------------------------------------------
    /** INTERNAL FUNCTIONS */

    /**
     * @dev Checks if a token is supported.
     * @param token The address of the token.
     */
    function allowedToken(address token) internal view {
        if (!supportedTokens[token].supported) revert TokenNotSupported();
    }
}
