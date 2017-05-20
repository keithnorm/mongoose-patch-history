'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.RollbackError = undefined;

exports.default = function (schema, opts) {
  var options = (0, _lodash.merge)({}, defaultOptions, opts);

  // validate parameters
  (0, _assert2.default)(options.mongoose, '`mongoose` option must be defined');
  (0, _assert2.default)(options.name, '`name` option must be defined');
  (0, _assert2.default)(!schema.methods.data, 'conflicting instance method: `data`');

  // used to compare instance data snapshots. depopulates instance,
  // removes version key and object id
  schema.methods.data = function () {
    return this.toObject({
      depopulate: true,
      versionKey: false,
      transform: function transform(doc, ret, options) {
        delete ret._id;
        // if timestamps option is set on schema, ignore timestamp fields
        if (schema.options.timestamps) {
          delete ret[schema.options.timestamps.createdAt || 'createdAt'];
          delete ret[schema.options.timestamps.updatedAt || 'updatedAt'];
        }
      }
    });
  };

  // roll the document back to the state of a given patch id
  schema.methods.rollback = function (patchId, data) {
    var _this = this;

    return this.patches.find({ ref: this.id }).sort({ _id: -1 }).exec().then(function (patches) {
      return new _bluebird2.default(function (resolve, reject) {
        // patch doesn't exist
        if (!~(0, _lodash.map)(patches, 'id').indexOf(patchId)) {
          return reject(new RollbackError('patch doesn\'t exist'));
        }

        // apply patches to `state`
        var state = _this.toObject();
        patches.some(function (patch) {
          var _iteratorNormalCompletion = true;
          var _didIteratorError = false;
          var _iteratorError = undefined;

          try {
            for (var _iterator = patch.ops[Symbol.iterator](), _step; !(_iteratorNormalCompletion = (_step = _iterator.next()).done); _iteratorNormalCompletion = true) {
              var change = _step.value;

              _deepDiff2.default.revertChange(state, {}, change);
            }
          } catch (err) {
            _didIteratorError = true;
            _iteratorError = err;
          } finally {
            try {
              if (!_iteratorNormalCompletion && _iterator.return) {
                _iterator.return();
              }
            } finally {
              if (_didIteratorError) {
                throw _iteratorError;
              }
            }
          }

          return patch.id === patchId;
        });

        // save new state and resolve with the resulting document
        _this.set((0, _lodash.merge)(state, data)).save().then(resolve).catch(reject);
      });
    });
  };

  // create patch model, enable static model access via `Patches` and
  // instance method access through an instances `patches` property
  var Patches = createPatchModel(options);
  schema.statics.Patches = Patches;
  schema.virtual('patches').get(function () {
    return Patches;
  });

  // after a document is initialized or saved, fresh snapshots of the
  // documents data are created
  var snapshot = function snapshot() {
    this._original = toJSON(this.data());
  };
  schema.post('init', snapshot);

  // when a document is removed and `removePatches` is not set to false ,
  // all patch documents from the associated patch collection are also removed
  schema.pre('remove', function (next) {
    if (!options.removePatches) {
      return next();
    }

    var ref = this._id;

    this.patches.find({ ref: ref }).then(function (patches) {
      return (0, _bluebird.join)(patches.map(function (patch) {
        return patch.remove();
      }));
    }).then(next).catch(next);
  });

  schema.pre('save', function (next) {
    this.wasNew = this.isNew;
    next();
  });

  // when a document is saved, the json patch that reflects the changes is
  // computed. if the patch consists of one or more operations (meaning the
  // document has changed), a new patch document reflecting the changes is
  // added to the associated patch collection
  schema.post('save', function (doc, next) {
    var _this2 = this;

    var ref = this._id;

    var ops = _deepDiff2.default.diff(this.wasNew ? {} : this._original, toJSON(this.data()));

    // don't save a patch when there are no changes to save
    if (!ops) {
      return next();
    }

    // assemble patch data
    var data = { ops: ops, ref: ref };
    (0, _lodash.each)(options.includes, function (type, name) {
      data[name] = _this2[type.from || name];
    });

    this.patches.create(data).then(function () {
      snapshot.call(_this2);
      next();
    }).catch(next);
  });
};

var _assert = require('assert');

var _assert2 = _interopRequireDefault(_assert);

var _mongoose = require('mongoose');

var _bluebird = require('bluebird');

var _bluebird2 = _interopRequireDefault(_bluebird);

var _deepDiff = require('deep-diff');

var _deepDiff2 = _interopRequireDefault(_deepDiff);

var _humps = require('humps');

var _lodash = require('lodash');

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

var RollbackError = exports.RollbackError = function RollbackError(message, extra) {
  Error.captureStackTrace(this, this.constructor);
  this.name = 'RollbackError';
  this.message = message;
};

require('util').inherits(RollbackError, Error);

var createPatchModel = function createPatchModel(options) {
  var def = {
    date: { type: Date, required: true, default: Date.now },
    ops: { type: [], required: true },
    ref: { type: _mongoose.Schema.Types.ObjectId, required: true, index: true }
  };

  (0, _lodash.each)(options.includes, function (type, name) {
    def[name] = (0, _lodash.omit)(type, 'from');
  });

  var PatchSchema = new _mongoose.Schema(def);

  return options.mongoose.model(options.transforms[0]('' + options.name), PatchSchema, options.transforms[1]('' + options.name));
};

var defaultOptions = {
  includes: {},
  removePatches: true,
  transforms: [_humps.pascalize, _humps.decamelize]
};

// used to convert bson to json - especially ObjectID references need
// to be converted to hex strings so that the jsonpatch `compare` method
// works correctly
var toJSON = function toJSON(obj) {
  return JSON.parse(JSON.stringify(obj));
};