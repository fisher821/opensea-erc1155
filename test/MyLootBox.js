/* libraries used */

const truffleAssert = require('truffle-assertions');

const vals = require('../lib/testValuesCommon.js');

/* Contracts in this test */

const MockProxyRegistry = artifacts.require(
  "../contracts/MockProxyRegistry.sol"
);
const MyLootBox = artifacts.require("../contracts/MyLootBox.sol");
const MyCollectible = artifacts.require("../contracts/MyCollectible.sol");


/* Useful aliases */

const toBN = web3.utils.toBN;


/* Utility Functions */

// Not a function, the fields of the TransferSingle event.

const TRANSFER_SINGLE_FIELDS = [
  { type: 'address', name: '_operator', indexed: true },
  { type: 'address', name: '_from', indexed: true },
  { type: 'address', name: '_to', indexed: true },
  { type: 'uint256', name: '_id' },
  { type: 'uint256', name: '_amount' }
];

// Not a function, the keccak of the TransferSingle event.

const TRANSFER_SINGLE_SIG = web3.eth.abi.encodeEventSignature({
  name: 'TransferSingle',
  type: 'event',
  inputs: TRANSFER_SINGLE_FIELDS
});

// Check the option settings to make sure the values in the smart contract
// match the expected ones.

const checkOption = async (
  myLootBox, index, maxQuantityPerOpen, hasGuaranteedClasses
) => {
  const option = await myLootBox.optionToSettings(index);
  assert.isOk(option.maxQuantityPerOpen.eq(toBN(maxQuantityPerOpen)));
  assert.equal(option.hasGuaranteedClasses, hasGuaranteedClasses);
};

// Total the number of tokens in the transaction's emitted TransferSingle events
// Keep a total for each token id number (1:..2:..)
// and a total for *all* tokens as total:.

const totalEventTokens = (receipt, recipient) => {
  // total is our running total for all tokens
  const totals = {total: toBN(0)};
  // Parse each log from the event
  for (let i = 0; i < receipt.receipt.rawLogs.length; i++) {
    const raw = receipt.receipt.rawLogs[i];
    // Filter events so we process only the TransferSingle events
    // Note that topic[0] is the event signature hash
    if (raw.topics[0] === TRANSFER_SINGLE_SIG) {
      // Fields of TransferSingle
      let parsed = web3.eth.abi.decodeLog(
        TRANSFER_SINGLE_FIELDS,
        raw.data,
        // Exclude event signature hash from topics that we process here.
        raw.topics.slice(1)
      );
      // Make sure the correct recipient got the tokens.
      assert.equal(parsed._to, recipient);
      // Keep a running total for each token id.
      const id = parsed._id;
      if (! totals[id]) {
        totals[id] = toBN(0);
      }
      const amount = toBN(parsed._amount);
      totals[id] = totals[id].add(amount);
      // Keep a running total for all token ids.
      totals.total = totals.total.add(amount);
    }
  }
  return totals;
};

// Compare the token amounts map generated by totalEventTokens to a spec object.
// The spec should match the guarantees[] array for the option.

const compareTokenTotals = (totals, spec, option) => {
  Object.keys(spec).forEach(key => {
    assert.isOk(
      // Because it's an Object.keys() value, key is a string.
      // We want that for the spec, as it is the correct key.
      // But to add one we want a number, so we parse it then add one.
      // Why do we want to add one?
      // Because due to the internals of the smart contract, the token id
      // will be one higher than the guarantees index.
      totals[parseInt(key) + 1] || toBN(0).gte(spec[key]),
      `Mismatch for option ${option} guarantees[${key}]`
    );
  });
};


/* Tests */

contract("MyLootBox", (accounts) => {
  // As set in (or inferred from) the contract
  const BASIC = toBN(0);
  const PREMIUM = toBN(1);
  const GOLD = toBN(2);
  const OPTIONS = [BASIC, PREMIUM, GOLD];
  const NUM_OPTIONS = OPTIONS.length;
  const NO_SUCH_OPTION = toBN(NUM_OPTIONS + 10);
  const OPTIONS_AMOUNTS = [toBN(3), toBN(5), toBN(7)];
  const OPTION_GUARANTEES = [
    {},
    { 0: toBN(3) },
    { 0: toBN(3), 2: toBN(2), 4: toBN(1) }
  ];

  const owner = accounts[0];
  const userA = accounts[1];
  const userB = accounts[2];
  const proxyForOwner = accounts[8];

  let myLootBox;
  let myCollectible;
  let proxy;

  before(async () => {
    proxy = await MockProxyRegistry.new();
    await proxy.setProxy(owner, proxyForOwner);
    myCollectible = await MyCollectible.new(proxy.address);
    myLootBox = await MyLootBox.new(
      proxy.address,
      myCollectible.address
    );
    await myCollectible.transferOwnership(myLootBox.address);
  });

  // This also tests the proxyRegistryAddress and nftAddress accessors.

  describe('#constructor()', () => {
    it('should set proxyRegistryAddress to the supplied value', async () => {
      assert.equal(await myLootBox.proxyRegistryAddress(), proxy.address);
      assert.equal(await myLootBox.nftAddress(), myCollectible.address);
    });

    it('should set options to values in constructor', async () => {
      await checkOption(myLootBox, BASIC, 3, false);
      await checkOption(myLootBox, PREMIUM, 5, true);
      await checkOption(myLootBox, GOLD, 7, true);
    });
  });

  // Calls _mint()

  describe('#safeTransferFrom()', () => {
    it('should work for owner()', async () => {
      const option = BASIC;
      const amount = toBN(1);
      const receipt = await myLootBox.safeTransferFrom(
        vals.ADDRESS_ZERO,
        userB,
        option,
        amount,
        "0x0",
        { from: owner }
      );
      truffleAssert.eventEmitted(
        receipt,
        'LootBoxOpened',
        {
          boxesPurchased: amount,
          optionId: option,
          buyer: userB,
          itemsMinted: OPTIONS_AMOUNTS[option]
        }
      );
      const totals = totalEventTokens(receipt, userB);
      assert.ok(totals.total.eq(OPTIONS_AMOUNTS[option]));
    });

    it('should work for proxy', async () => {
      const option = BASIC;
      const amount = toBN(1);
      const receipt = await myLootBox.safeTransferFrom(
          vals.ADDRESS_ZERO,
          userB,
          option,
          amount,
          "0x0",
          { from: proxyForOwner }
      );
      truffleAssert.eventEmitted(
        receipt,
        'LootBoxOpened',
        {
          boxesPurchased: amount,
          optionId: option,
          buyer: userB,
          itemsMinted: OPTIONS_AMOUNTS[option]
        }
      );
      const totals = totalEventTokens(receipt, userB);
      assert.ok(totals.total.eq(OPTIONS_AMOUNTS[option]));
    });

    it('should not be callable by non-owner() and non-proxy', async () => {
      const amount = toBN(1);
      await truffleAssert.fails(
        myLootBox.safeTransferFrom(
          vals.ADDRESS_ZERO,
          userB,
          PREMIUM,
          amount,
          "0x0",
          { from: userB }
        ),
        truffleAssert.ErrorType.REVERT,
        'MyLootBox#_mint: CANNOT_MINT'
      );
    });

    it('should not work for invalid option', async () => {
      const amount = toBN(1);
      await truffleAssert.fails(
        myLootBox.safeTransferFrom(
          vals.ADDRESS_ZERO,
          userB,
          NO_SUCH_OPTION,
          amount,
          "0x0",
          { from: owner }
        ),
        // The bad Option cast gives an invalid opcode exception.
        truffleAssert.ErrorType.INVALID_OPCODE
      );
    });

    it('should mint guaranteed class amounts for each option', async () => {
      for (let i = 0; i < NUM_OPTIONS; i++) {
        const option = OPTIONS[i];
        const amount = toBN(1);
        const receipt = await myLootBox.safeTransferFrom(
          vals.ADDRESS_ZERO,
          userB,
          option,
          amount,
          "0x0",
          { from: owner }
        );
        truffleAssert.eventEmitted(
          receipt,
          'LootBoxOpened',
          {
            boxesPurchased: amount,
            optionId: option,
            buyer: userB,
            itemsMinted: OPTIONS_AMOUNTS[option]
          }
        );
        const totals = totalEventTokens(receipt, userB);
        assert.ok(totals.total.eq(OPTIONS_AMOUNTS[option]));
        compareTokenTotals(totals, OPTION_GUARANTEES[option], option);
      }
    });
  });
});