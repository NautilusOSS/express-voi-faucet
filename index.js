const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const axios = require("axios");
const https = require("https");
const fs = require("fs");
const algosdk = require("algosdk");
require("dotenv").config();

const {
  MN,
  RECAPTCHA_SITE_KEY,
  RECAPTCHA_SECRET_KEY,
  ALGO_SERVER,
  ALGO_INDEXER_SERVER,
  ALLOWED_ROUNDS,
} = process.env;

// -----------------------------------------------
// quest
// -----------------------------------------------
const QUEST_API = "https://quest.nautilus.sh";
const QUEST_ACTION = {
  FAUCET_DRIP: "faucet_drip_once"
}
const submitAction = (action, address, params = {}) => {
  return axios.post(
    `${QUEST_API}/quest`,
    {
      action,
      data: {
        wallets: [
          {
            address,
          },
        ],
        ...params,
      },
    },
    {
      headers: {
        "Content-Type": "application/json",
      },
    }
  );
};
// -----------------------------------------------

const algodClient = new algosdk.Algodv2(
  process.env.ALGOD_TOKEN || "",
  process.env.ALGOD_SERVER || ALGO_SERVER,
  process.env.ALGOD_PORT || ""
);

const indexerClient = new algosdk.Indexer(
  process.env.INDEXER_TOKEN || "",
  process.env.INDEXER_SERVER || ALGO_INDEXER_SERVER,
  process.env.INDEXER_PORT || ""
);

const signSendAndConfirm = async (txns, sk) => {
  const stxns = txns
    .map((t) => new Uint8Array(Buffer.from(t, "base64")))
    .map(algosdk.decodeUnsignedTransaction)
    .map((t) => algosdk.signTransaction(t, sk));
  await algodClient.sendRawTransaction(stxns.map(({ blob }) => blob)).do();
  await Promise.all(
    stxns.map(({ txID }) => algosdk.waitForConfirmation(algodClient, txID, 4))
  );
  return stxns.map(({ txID }) => txID);
};

const app = express();
const port = 3000;

app.use(cors());
app.use(bodyParser.urlencoded({ extended: true }));

app.post("/submit-form", async (req, res) => {
  const { recaptcha: token, target } = req.body;

  if (!token) {
    return res.status(400).json({ message: "reCAPTCHA token is missing" });
  }

  if (!target) {
    return res.status(400).json({ message: "address is missing" });
  }

  const ADDRESS_REGEX = /[A-Z0-9]{58}/;

  if (!ADDRESS_REGEX.test(target)) {
    return res.status(400).json({ message: "address is invalid" });
  }

  try {
    const response = await axios.post(
      `https://www.google.com/recaptcha/api/siteverify`,
      null,
      {
        params: {
          secret: RECAPTCHA_SECRET_KEY,
          response: token,
        },
      }
    );

    const { success, score } = response.data;

    if (!success || score < 0.5) {
      // Adjust the score threshold as needed
      return res.status(400).json({ message: "reCAPTCHA verification failed" });
    }

    // Begin

    const { addr, sk } = algosdk.mnemonicToSecretKey(MN);

    const status = await algodClient.status().do();
    const lastRound = status["last-round"];
    const allowedRounds = Number(ALLOWED_ROUNDS);

    const { CONTRACT, abi } = await import("ulujs");

    const VIA = 6779767;
    const dripAmount = 1000 * 1e6;

    const ci = new CONTRACT(VIA, algodClient, indexerClient, abi.arc200, {
      addr,
      sk: new Uint8Array(0),
    });

    const transferEvents = (
      await ci.arc200_Transfer({
        minRound: lastRound - allowedRounds,
        address: addr,
        sender: addr,
      })
    ).filter((el) => el[4] === target);

    if (transferEvents.length > 0) {
      return res
        .status(400)
        .json({ message: "faucet usage limited exceeded (1 per hour)" });
    }

    // get account info
    //   if zero balance transfer 1
    const accountInfo = await algodClient.accountInformation(target).do();
    if(accountInfo.amount === 0) {
	    const suggestedParams = await algodClient.getTransactionParams().do();
	    const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
		amount: 10 * 1e6,
		from: addr,
		to: target,
		suggestedParams
	    })
	    await algodClient
  		.sendRawTransaction(txn.signTxn(sk))
  		.do();
    }

    const arc200_transferR = await ci.arc200_transfer(target, dripAmount);
    let txID;
    if (arc200_transferR.success) {
      const res = await signSendAndConfirm(arc200_transferR.txns, sk);
      txID = res.pop();
    } else {
	ci.setPaymentAmount(28500);
    	const arc200_transferR = await ci.arc200_transfer(target, dripAmount);
	if(!arc200_transferR.success) throw new Error("simulation failed");
      	const res = await signSendAndConfirm(arc200_transferR.txns, sk);
	txID = res.slice(-1).pop();    
    }

    await submitAction(QUEST_ACTION.FAUCET_DRIP, target, { contractId: VIA });

    return res.status(200).json({ message: 'Form submitted successfully', txID });

  } catch (error) {
    console.error("reCAPTCHA verification error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
