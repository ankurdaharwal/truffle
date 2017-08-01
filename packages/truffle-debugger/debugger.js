var expect = require("truffle-expect");
var contract = require("truffle-contract");
var Web3 = require("web3");
var dir = require("node-dir");
var path = require("path");
var async = require("async");
var OS = require("os");
var Context = require("./context");
var Call = require("./call");

function Debugger(config) {
  this.config = config;
  this.tx_hash;
  this.trace = [];
  this.traceIndex = 0;
  this.callstack = [];
  this.addressContexts = {};
  this.codeContexts = {};
  this.contracts = [];
}

/**
 * Function: debug
 *
 * Debug a specific transaction that occurred on the blockchain.
 *
 * @param  {[type]}   tx_hash  [description]
 * @param  {Function} callback [description]
 * @return [type]              [description]
 */

Debugger.prototype.start = function(tx_hash, callback) {
  var self = this;

  expect.options(this.config, [
    "provider",
    "resolver"
  ]);

  // General strategy:
  //
  // 1. Get trace for tx
  // 2. Gather up all available contract artifacts
  // 3. Analyze trace for affected addresses
  // 4. Create "contexts" for each address, and pair the address up with its
  //    associated contract artifacts (using the deployed bytecode)
  // 5. Convert deployed bytecode to instructions within each context, and
  //    map byecode indexes (program counters) to each instruction.
  // 6. Start debugging by walking through the trace instruction by instruction
  //    and manage a call stack that helps us map trace instructions to their
  //    source maps.

  this.web3 = new Web3();
  this.web3.setProvider(this.config.provider);

  this.config.provider.sendAsync({
    jsonrpc: "2.0",
    method: "debug_traceTransaction",
    params: [tx_hash],
    id: new Date().getTime()
  }, function(err, result) {
    if (err) return callback(err);

    if (result.error) {
      return callback(new Error("The debugger receieved an error while requesting the transaction trace. Ensure your Ethereum client supports transaction traces and that the transaction reqeusted exists on chain before debugging." + OS.EOL + OS.EOL + result.error.message));
    }

    self.trace = result.result.structLogs;

    // Get the primary address associated with the transaction.
    // This is either the to address or the contract created by the transaction.
    self.getPrimaryAddress(tx_hash, function(err, primaryAddress, isContractCreation) {
      if (err) return callback(err);

      // Gather all available contract artifacts
      dir.files(self.config.contracts_build_directory, function(err, files) {
        if (err) return callback(err);

        self.contracts = files.filter(function(file_path) {
          return path.extname(file_path) == ".json";
        }).map(function(file_path) {
          return path.basename(file_path, ".json");
        }).map(function(contract_name) {
          return self.config.resolver.require(contract_name);
        });

        async.each(self.contracts, function(abstraction, finished) {
          abstraction.detectNetwork().then(function() {
            finished();
          }).catch(finished);
        }, function(err) {
          if (err) return callback(err);

          self.tx_hash = tx_hash;

          // Analyze the trace and create contexts for each address.
          // Of course, to start, we create a context for the initial contract called.
          var addresses = {
            [primaryAddress]: true // a marker to help us dedupe
          };

          self.trace.forEach(function(step, index) {
            if (step.op == "CALL" || step.op == "DELEGATECALL") {
              var address = self.callAddress(step)
              addresses[address] = true;
            }
          });

          var promises = Object.keys(addresses).map(function(address) {
            return self.getDeployedCode(address);
          });

          Promise.all(promises).then(function(deployedBinaries) {
            // Find contracts that match the code at each address, then create a new context
            // for each one. This context is mapped to the address as well as the bytecode.
            Object.keys(addresses).forEach(function(address, index) {
              self.addressContexts[address] = self.contextForBinary(deployedBinaries[index]);
            });

            // Start the trace at the beginning
            self.traceIndex = 0;

            // Push our entry point onto the call stack
            self.pushCallForAddress(primaryAddress, isContractCreation);

            // Get started! We pass the contexts to the callback for
            // information purposes.
            callback(null, self.addressContexts);
          }).catch(callback);
        });
      });
    });
  });
};

/**
 * getPrimaryAddress - get the primary address associated with the passed transaction.
 *
 * This will return the to address, if the transaction is made to an existing contract;
 * or else it will return the address of the contract created as a result of the transaction.
 *
 * @param  {String}   tx_hash  Hash of the transaction
 * @param  {Function} callback Callback function that accepts three params (err, primaryAddress, isContractCreation)
 * @return {String}            Primary address of the transaction
 */
Debugger.prototype.getPrimaryAddress = function(tx_hash, callback) {
  var self = this;
  this.web3.eth.getTransaction(tx_hash, function(err, tx) {
    if (err) return callback(err);

    // Maybe there's a better way to check for this.
    // Some clients return 0x0 when transaction is a contract creation.
    if (tx.to && tx.to != "0x0") {
      return callback(null, tx.to, false);
    }

    self.web3.eth.getTransactionReceipt(tx_hash, function(err, receipt) {
      if (err) return callback(err);

      if (receipt.contractAddress) {
        return callback(null, receipt.contractAddress, true);
      }

      return callback(new Error("Could not find contract associated with transaction. Please make sure you're debugging a transaction that executes a contract function or creates a new contract."));
    });
  });
};

/**
 * currentInstruction - get the current instruction the debugger is evaluating
 * @return {Object} instruction being evaluated by the debugger, null if no available instruction.
 */
Debugger.prototype.currentInstruction = function() {
  var currentCall = this.currentCall();

  if (!currentCall) return null;

  return currentCall.currentInstruction();
};

/**
 * currentCall - get call on the top of the call stack
 * @return {Call} call on the top of the call stack, or null if none available.
 */
Debugger.prototype.currentCall = function() {
  return this.callstack[this.callstack.length - 1];
}

/**
 * functionDepth - get the depth of jumps made relative to Solidity functions
 *
 * Specific jumps are marked as either entering or leaving a function.
 * functionDepth() expresses the amount of function calls currently made.
 *
 * @return {Number} function depth
 */
Debugger.prototype.functionDepth = function() {
  return this.callstack.reduce(function(sum, call) {
    return call.functionDepth;
  }, 0);
};

/**
 * advance - advance one instruction
 * @return Object Returns the current instruction after incrementing one instruction.
 */
Debugger.prototype.advance = function() {
  var currentInstruction;

  // Handle calls before advancing
  if (this.isCall()) {
    this.executeCall();
    this.traceIndex += 1;
  } else if (this.isCreate()) {
    this.executeCreate();
    this.traceIndex += 1;
  } else {
    // Check to see if this is a halting instruction.
    // If so, pop the call stack.
    var lastCall;
    if (this.isSuccessfulHaltingInstruction()) {
      lastCall = this.callstack.pop();
    }

    // If the debugger is now stopped, don't continue.
    if (this.isStopped()) {
      return null;
    }

    var currentCall = this.currentCall();
    var currentStep = this.currentStep();
    currentCall.advance(currentStep.stack);
    this.traceIndex += 1;

    // If the last call created a contract, let's update our addressContexts
    if (lastCall && lastCall.type == "create") {
      // Remove leading zeroes from address and add "0x" prefix.
      var newAddress = "0x" + currentStep.stack[currentStep.stack.length - 1].substring(24);
      this.addressContexts[newAddress] = lastCall.context;
    }
  }

  currentInstruction = this.currentInstruction();

  if (currentInstruction) {
    // Determine if instruction matches traceIndex
    // If they don't match, it means there's a problem with the debugger.
    var step = this.currentStep();

    // Note that we may have exhausted all available steps in the trace.
    // In cases of runtime errors, normal halting instructions won't be executed
    // and the trace will end abruptly.
    if (step && step.op != currentInstruction.name) {

      var message = "Trace and instruction mismatch." + OS.EOL
        + OS.EOL
        + "trace " + JSON.stringify(step, null, 2) + OS.EOL
        + "instruction " + JSON.stringify(currentInstruction, null, 2) + OS.EOL
        + OS.EOL
        + "This is likely due to a bug in the debugger. Please file an issue on the Truffle issue tracker and provide as much information about your code and transaction as possible." + OS.EOL
        + OS.EOL
        + "Fatal Error: See above.";

      throw new Error(message)
    }
  }

  return currentInstruction;
}

/**
 * step - step to the next logical code segment
 *
 * Note: It might take multiple instructions to express the same section of code.
 * "Stepping", then, is stepping to the next logical item, not stepping to the next
 * instruction. See advance() if you'd like to advance by one instruction.
 *
 * @return object Returns the current instruction stepped to.
 */
Debugger.prototype.step = function() {
  if (this.isStopped()) {
    return;
  }

  var startingInstruction = this.currentInstruction();

  while (this.currentInstruction().start == startingInstruction.start && this.currentInstruction().length == startingInstruction.length) {
    this.advance();

    if (this.isStopped()) {
      break;
    }
  }

  return this.currentInstruction();
};

/**
 * stepInto - step into the current function
 *
 * Conceptually this is easy, but from a programming standpoint it's hard.
 * Code like `getBalance(msg.sender)` might be highlighted, but there could
 * be a number of different intermediate steps (like evaluating `msg.sender`)
 * before `getBalance` is stepped into. This function will step into the first
 * function available (where instruction.jump == "i"), ignoring any intermediate
 * steps that fall within the same code range. If there's a step encountered
 * that exists outside of the range, then stepInto will only execute until that
 * step.
 *
 * @return object Returns the current instruction stepped to.
 */
Debugger.prototype.stepInto = function() {
  if (this.isStopped()) {
    return;
  }

  var startingInstruction = this.currentInstruction();
  var startingDepth = this.functionDepth();

  // If we're directly on a jump, then just do it.
  if (this.isJump(startingInstruction)) {
    return this.step();
  }

  // If we're at an instruction that has a multiline code range (like a function definition)
  // treat this step into like a step over as they're functionally equivalent.
  if (this.hasMultiLineCodeRange(startingInstruction)) {
    return this.stepOver();
  }

  // So we're not directly on a jump, and we're not multi line.
  // Let's step until we either find a jump or get out of the current range.
  while (true) {
    var newInstruction = this.step();

    if (this.isStopped()) {
      break;
    }

    // Check to see if we've made our jump. If so, get outta here.
    if (this.functionDepth() > startingDepth) {
      break;
    }

    var lowerBounds = startingInstruction.start;
    var upperBounds = startingInstruction.start + startingInstruction.length;

    var newInstructionStart = newInstruction.start;
    var newInstructionEnd = newInstruction.start + newInstruction.length;

    // If we have a new instruction that exists outside of the starting range,
    // then the starting instruction must not have been one that jumps anywhere.
    if (newInstructionStart < lowerBounds || newInstructionEnd > upperBounds) {
      break;
    }
  }

  return this.currentInstruction();
};

/**
 * stepOut - step out of the current function
 *
 * This will run until the debugger encounters a decrease in function depth.
 *
 * @return [type]              [description]
 */
Debugger.prototype.stepOut = function() {
  if (this.isStopped()) {
    return;
  }

  var startingInstruction = this.currentInstruction();
  var startingDepth = this.functionDepth();

  while (this.functionDepth() >= startingDepth) {
    this.step();

    if (this.isStopped()) {
      break;
    }
  }

  return this.currentInstruction();
};

/**
 * stepOver - step over the current line
 *
 * Step over the current line. This will step to the next instruction that
 * exists on a different line of code within the same function depth.
 *
 * @return Object Returns the current instruction stepped to.
 */
Debugger.prototype.stepOver = function() {
  if (this.isStopped()) {
    return;
  }

  var startingInstruction = this.currentInstruction();
  var startingDepth = this.functionDepth();
  var startingCallDepth = this.callstack.length;

  while (true) {
    var newInstruction = this.step();
    var newCallDepth = this.callstack.length;

    if (this.isStopped()) {
      break;
    }

    // If stepping over caused us to step out of a contract, quit.
    if (newCallDepth < startingCallDepth) {
      break;
    }

    // If we encountered a new line, bail, but only do it when we're at the same functionDepth
    // (i.e., don't step into any new function calls). However, be careful to stop stepping
    // if we step out of the function.
    if (newCallDepth == startingCallDepth && newInstruction.range.start.line != startingInstruction.range.start.line && this.functionDepth() <= startingDepth) {
      break;
    }
  }

  return this.currentInstruction();
};

/**
 * getSource - get the source file that produced the current instruction
 * @return String Full source code that produced the current instruction
 */
Debugger.prototype.currentSource = function() {
  return this.callstack[this.callstack.length - 1].context.source;
};

/**
 * currentSourcePath - get the file path of the source code that produced the current instruction
 * @return {String} File path of the source code that produced the current instruction
 */
Debugger.prototype.currentSourcePath = function() {
  return this.callstack[this.callstack.length - 1].context.sourcePath;
};

/**
 * currentStep - get the current trace instruction
 * @return {Object} trace instruction at the current state of the debugger
 */
Debugger.prototype.currentStep = function() {
  return this.trace[this.traceIndex];
};

/**
 * isJump - detect whether an opcode instruction is on that can affect function depth
 * @param  {instruction} instruction Optional instruction to evaluate
 * @return {boolean}             whether or not instruction is a jump
 */
Debugger.prototype.isJump = function(instruction) {
  if (!instruction) {
    instruction = this.currentInstruction();
  }
  return instruction.name != "JUMPDEST" && instruction.name.indexOf("JUMP") == 0;
};

/**
 * isCall - detect whether an opcode instruction can affect the call stack
 * @param  {instruction} instruction Optional instruction to evaluate
 * @return {Boolean}             whether or not instruction is a contract call
 */
Debugger.prototype.isCall = function(instruction) {
  if (!instruction) {
    instruction = this.currentInstruction();
  }
  return instruction.name == "CALL" || instruction.name == "DELEGATECALL";
};

/**
 * isCreate - detect whether an opcode instruction creates a new contract
 * @param  {instruction} instruction Optional instruction to evaluate
 * @return {Boolean}             whether or not instruction creates a new contract
 */
Debugger.prototype.isCreate = function(instruction) {
  if (!instruction) {
    instruction = this.currentInstruction();
  }
  return instruction.name == "CREATE";
};

/**
 * isSuccessfulHaltingInstruction - detect whether an opcode instruction halts the current contract
 * @param  {instruction} instruction Optional instruction to evaluate
 * @return {Boolean}             whether or not instruction halts the current contract
 */
Debugger.prototype.isSuccessfulHaltingInstruction = function(instruction) {
  if (!instruction) {
    instruction = this.currentInstruction();
  }
  return instruction.name == "STOP" || instruction.name == "RETURN";
};

/**
 * hasMultiLineCodeRange - detect whether code range is multiline
 * @param  {instruction} instruction instruction to evaluate
 * @return {Boolean}             wehther or not instruction has a multiline code range
 */
Debugger.prototype.hasMultiLineCodeRange = function(instruction) {
  return instruction.range.start.line != instruction.range.end.line;
};

/**
 * pushCallForAddress - use this bump the call stack with a specific address
 *
 * The correct code context will be found based on the address input.
 *
 * @param  {String}  address
 * @param  {Boolean} isContractCreation Whether or not this is a contract creation call
 */
Debugger.prototype.pushCallForAddress = function(address, isContractCreation) {
  this.pushCallForContext(this.addressContexts[address], isContractCreation);
};

/**
 * pushCallForContext - given a context, bump the call stack
 * @param  {Context}  context
 * @param  {Boolean} isContractCreation Whether or not this is a contract creation call
 */
Debugger.prototype.pushCallForContext = function(context, isContractCreation) {
  var callType = !!isContractCreation ? "create" : "call";
  var newCall = new Call(context, callType)
  this.callstack.push(newCall);
};

/**
 * executeCall - detect the address of a call and add to the call stack
 */
Debugger.prototype.executeCall = function() {
  var step = this.trace[this.traceIndex];
  var address = this.callAddress(step);
  this.pushCallForAddress(address);
};

/**
 * executeCall - detect the address of a call and add to the call stack
 */
Debugger.prototype.executeCreate = function(isContractCreation) {
  var step = this.trace[this.traceIndex];
  var currentCall = this.currentCall();
  var currentBinary = currentCall.binary();
  var memory = step.memory.join("");

  // Get the code that's going to be created from memory.
  // Note we multiply by 2 because these offsets are in bytes.
  var inputOffset = parseInt(step.stack[step.stack.length - 2], 16) * 2;
  var inputSize = parseInt(step.stack[step.stack.length - 3], 16) * 2;

  var creationBinary = "0x" + memory.substring(inputOffset, inputOffset + inputSize);
  var context = this.contextForBinary(creationBinary);

  this.pushCallForContext(context, true);
};

/**
 * callAddress - get the address off the stack for a current call instruction
 * @param  {trace instruction} step Trace item that represents the call
 * @return {String}      Address of contract pointed to by this call
 */
Debugger.prototype.callAddress = function(step) {
  var address = step.stack[step.stack.length - 2];

  // Remove leading zeroes from address and add "0x" prefix.
  address = "0x" + address.substring(24);

  return address;
};

/**
 * isStopped - determine whether the debugger is currently debugging a transaction
 * @return Boolean true if stopped; false if still debugging
 */
Debugger.prototype.isStopped = function() {
  return this.traceIndex >= this.trace.length || this.callstack.length == 0;
}

/**
 * isRuntimeError - determine whether stopped state of the debugger is due to a runtime error
 * @return {Boolean} true if runtime error; false if normal halting instruction
 */
Debugger.prototype.isRuntimeError = function() {
  return this.traceIndex >= this.trace.length && this.callstack.length > 0;
};

/**
 * getDeployedCode - get the deployed code for an address from the client
 * @param  {String} address
 * @return {String}         deployedBinary
 */
Debugger.prototype.getDeployedCode = function(address) {
  var self = this;
  return new Promise(function(accept, reject) {
    self.web3.eth.getCode(address, function(err, deployedBinary) {
      if (err) return reject(err);
      accept(deployedBinary);
    });
  });
};

/**
 * contextForBinary - Given a binary, either create a new context or return an existing context
 * @param  {String} deployedBinary
 * @return {Context}
 */
Debugger.prototype.contextForBinary = function(deployedBinary) {
  var hash = this.web3.sha3(deployedBinary);

  if (!this.codeContexts[hash]) {
    var contract = this.findMatchingContract(deployedBinary);

    this.codeContexts[hash] = new Context(contract);
  }

  return this.codeContexts[hash];
};

/**
 * findMatchingContract - matches deployed bytecode with contract abstractions
 * @param  {String} deployedBinary Deployed binary to match
 * @return {contract}                contract abstraction representing matching contract
 */
Debugger.prototype.findMatchingContract = function(deployedBinary) {
  var self = this;

  var match = null;

  for (var i = 0; i < self.contracts.length; i++) {
    var contract = self.contracts[i];

    var contractBinary = contract.binary;
    var contractDeployedBinary = contract.deployedBinary;

    if (deployedBinary == contractBinary || deployedBinary == contractDeployedBinary) {
      match = contract;
      break;
    }
  }

  if (!match) {
    throw new Error("Could not find context for binary: " + deployedBinary);
  }

  if (!match.source) {
    throw new Error("Could not find source code for contract. Usually this is fixed by recompiling your contracts with the latest version of Truffle.");
  }

  var sourceMapErrorMessage = "Found matching contract could not find associated source map: Unable to debug. Usually this is fixed by recompiling your contracts with the latest version of Truffle.";

  if (!match.sourceMap && !match.deployedSourceMap) {
    throw new Error(sourceMapErrorMessage);
  }

  return match;
};

module.exports = Debugger;
