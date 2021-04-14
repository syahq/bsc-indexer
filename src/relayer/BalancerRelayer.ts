import { ethers } from 'ethers'
import { Contract } from '@ethersproject/contracts'
import {
  smartOrderRouter,
  getPoolsWithTokens,
  parsePoolData,
  formatSwapsExactAmountIn,
  calcTotalOutput
} from '@balancer-labs/sor'
import { BigNumber } from '@balancer-labs/sor/dist/utils/bignumber'

import Relayer from './Relayer'
import {
  BALANCER_HANDLER_ADDRESSES,
  WETH_ADDRESSES,
  ETH_ADDRESS
} from '../contracts'
import { logger, getGasPrice, BASE_FEE } from '../utils'
import { Order } from '../book/types'
import HandlerABI from '../contracts/abis/Handler.json'

export default class BalancerRelayer {
  base: Relayer
  balancerHandler: Contract
  skipOrdersBalancer: { [key: string]: boolean }

  constructor(base: Relayer) {
    this.base = base
    this.skipOrdersBalancer = {}

    this.balancerHandler = new Contract(
      BALANCER_HANDLER_ADDRESSES[base.chainId],
      HandlerABI,
      base.account
    )
  }

  async execute(order: Order): Promise<string | undefined> {
    if (this.skipOrdersBalancer[order.id]) {
      return undefined
    }

    try {
      // Get handler to use
      const handler = this.balancerHandler
      let poolA
      let poolB
      let expectedOut

      const WETH = WETH_ADDRESSES[this.base.chainId]
      const inputAddress =
        order.inputToken === ETH_ADDRESS ? WETH : order.inputToken
      const outputAddress =
        order.outputToken === ETH_ADDRESS ? WETH : order.outputToken
      const isTokenToToken =
        order.inputToken !== ETH_ADDRESS && order.outputToken !== ETH_ADDRESS
      if (isTokenToToken) {
        let data = await getPoolsWithTokens(inputAddress, WETH)
        let poolData = parsePoolData(
          data.pools.slice(0, 20),
          inputAddress,
          WETH
        ) // use 20 max

        let sorSwaps = smartOrderRouter(
          poolData,
          'swapExactIn',
          new BigNumber(order.inputAmount.toString()),
          1, // Check best pool
          new BigNumber('0')
        )

        poolA = sorSwaps[0].pool

        let swaps = formatSwapsExactAmountIn(
          sorSwaps,
          new BigNumber(ethers.constants.MaxUint256.toString()),
          new BigNumber(0)
        )
        expectedOut = calcTotalOutput(swaps, poolData)

        data = await getPoolsWithTokens(WETH, outputAddress)

        poolData = parsePoolData(data.pools.slice(0, 20), WETH, outputAddress)

        sorSwaps = smartOrderRouter(
          poolData,
          'swapExactIn',
          expectedOut,
          1, // Check best pool
          new BigNumber('0')
        )

        poolB = sorSwaps[0].pool

        swaps = formatSwapsExactAmountIn(
          sorSwaps,
          new BigNumber(ethers.constants.MaxUint256.toString()),
          new BigNumber(0)
        )

        expectedOut = calcTotalOutput(swaps, poolData)
      } else {
        const data = await getPoolsWithTokens(inputAddress, outputAddress)

        const poolData = parsePoolData(
          data.pools.slice(0, 20),
          inputAddress,
          outputAddress
        )

        const sorSwaps = smartOrderRouter(
          poolData,
          'swapExactIn',
          new BigNumber(order.inputAmount.toString()),
          1, // Check best pool
          new BigNumber('0')
        )

        const swaps = formatSwapsExactAmountIn(
          sorSwaps,
          new BigNumber(ethers.constants.MaxUint256.toString()),
          new BigNumber(0)
        )

        expectedOut = calcTotalOutput(swaps, poolData)

        poolA = sorSwaps[0].pool
        poolB = sorSwaps[0].pool
      }

      //console.log('pools founded:', poolA, poolB)
      logger.info(
        `${order.createdTxHash
        }: Can buy ${expectedOut.toString()} / ${order.minReturn.toString()}. ${expectedOut.div(
          order.minReturn.toString()
        )}%`
      )
      if (!poolA || !poolB) {
        return undefined
      }

      let params = this.getOrderExecutionParams(order, handler, poolA, poolB)

      // Get real estimated gas
      let estimatedGas = await this.base.estimateGasExecution(params)
      if (!estimatedGas) {
        return
      }

      let gasPrice = await getGasPrice()
      if (gasPrice.eq(0)) {
        gasPrice = await this.base.provider.getGasPrice()
      }

      let fee = this.base.getFee(gasPrice.mul(estimatedGas)) // gasPrice

      // Build execution params with fee
      params = this.getOrderExecutionParams(order, handler, poolA, poolB, fee)

      const gasLimit = estimatedGas.add(ethers.BigNumber.from(50000))
      // simulate
      if (process.env.PRIVATE_NODE_URL) {
        // Infura at estimate eth_call does not revert
        await this.base.unidexCore.callStatic.executeOrder(...params, {
          from: this.base.account.address,
          gasLimit,
          gasPrice
        })
      } else {
        await Promise.all([
          this.base.unidexCore.callStatic.executeOrder(...params, {
            from: this.base.account.address,
            gasLimit,
            gasPrice
          }),
          this.base.estimateGasExecution(params)
        ])
      }

      const isOrderOpen = await this.base.existOrder(order)
      if (!isOrderOpen) {
        return undefined
      }

      //  execute
      const tx = await this.base.unidexCore.executeOrder(...params, {
        from: this.base.account.address,
        gasLimit,
        gasPrice
      })

      logger.info(
        `Relayer: Filled ${order.createdTxHash} order, executedTxHash: ${tx.hash}`
      )
      return tx.hash
    } catch (e) {
      if (
        e.message.indexOf('There are no pools with selected') !== -1 ||
        e.message.indexOf("Cannot read property 'pool' of undefined") !== -1
      ) {
        this.skipOrdersBalancer[order.id] = true
      }

      logger.warn(
        `Relayer: Error filling order ${order.createdTxHash}: ${e.error ? e.error : e.message
        }`
      )
      return undefined
    }
  }

  getOrderExecutionParams(
    order: Order,
    handler: ethers.Contract,
    poolA: string,
    poolB: string,
    fee = BASE_FEE
  ): any {
    return [
      order.module,
      order.inputToken,
      order.owner,
      this.base.abiCoder.encode(
        ['address', 'uint256'],
        [order.outputToken, order.minReturn.toString()]
      ),
      order.signature,
      this.base.abiCoder.encode(
        ['address', 'address', 'uint256', 'address', 'address'],
        [handler.address, this.base.account.address, fee, poolA, poolB]
      )
    ]
  }
}
