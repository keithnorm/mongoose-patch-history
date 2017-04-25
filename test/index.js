import assert from 'assert'
import { map } from 'lodash'
import Promise, { join } from 'bluebird'
import mongoose, { Schema } from 'mongoose'
import patchHistory, { RollbackError } from '../src'

mongoose.Promise = Promise
const ObjectId = mongoose.Types.ObjectId

const CommentSchema = new Schema({ text: String })
CommentSchema.virtual('user').set(function (user) {
  this._user = user
})
CommentSchema.plugin(patchHistory, {
  mongoose,
  name: 'commentPatches',
  removePatches: false,
  includes: {
    text: {
      type: String
    },
    user: {
      type: Schema.Types.ObjectId,
      required: true,
      from: '_user'
    }
  }
})

const PostSchema = new Schema({ title: String }, { timestamps: true })
PostSchema.plugin(patchHistory, { mongoose,
  name: 'postPatches',
  transforms: [
    (name) => name.toLowerCase(),
    () => 'post_history'
  ]
})

describe('mongoose-patch-history', () => {
  let Comment, Post, User

  before((done) => {
    Comment = mongoose.model('Comment', CommentSchema)
    Post = mongoose.model('Post', PostSchema)
    User = mongoose.model('User', new Schema())

    mongoose.connect('mongodb://localhost/mongoose-patch-history', () => {
      join(
        Comment.remove(),
        Comment.Patches.remove(),
        Post.remove(),
        User.remove()
      )
      .then(() => User.create())
      .then(() => done())
    })
  })

  describe('initialization', () => {
    const name = 'testPatches'
    let TestSchema

    before(() => {
      TestSchema = new Schema()
    })

    it('throws when `mongoose` option is not defined', () => {
      assert.throws(() => TestSchema.plugin(patchHistory, { name }))
    })

    it('throws when `name` option is not defined', () => {
      assert.throws(() => TestSchema.plugin(patchHistory, { mongoose }))
    })

    it('throws when `data` instance method exists', () => {
      const DataSchema = new Schema()
      DataSchema.methods.data = () => {}
      assert.throws(() => DataSchema.plugin(patchHistory, { mongoose, name }))
    })

    it('does not throw with valid parameters', () => {
      assert.doesNotThrow(() => TestSchema.plugin(patchHistory, {
        mongoose,
        name
      }))
    })
  })

  describe('saving a new document', () => {
    it('adds a patch', (done) => {
      join(
        // without referenced user
        Post.create({ title: 'foo' })
          .then((post) => post.patches.find({ ref: post.id }))
          .then((patches) => {
            assert.equal(patches.length, 1)
            assert.equal(
              JSON.stringify(patches[0].ops),
              JSON.stringify([{"kind":"N","path":["title"],"rhs":"foo"}])
            )
          }),
        // with referenced user
        User.findOne()
          .then((user) => Comment.create({ text: 'wat', user: ObjectId() }))
          .then((comment) => comment.patches.find({ ref: comment.id }))
          .then((patches) => {
            assert.equal(patches.length, 1)
            assert.equal(
              JSON.stringify(patches[0].ops),
              JSON.stringify([{"kind":"N","path":["text"],"rhs":"wat"}])
            )
          })
      ).then(() => done()).catch(done)
    })
  })

  describe('saving an existing document', () => {
    it('with changes: adds a patch', (done) => {
      Post.findOne({ title: 'foo' })
        .then((post) => post.set({ title: 'bar' }).save())
        .then((post) => post.patches.find({ ref: post.id }).sort({ _id: 1 }))
        .then((patches) => {
          assert.equal(patches.length, 2)
          assert.equal(
            JSON.stringify(patches[1].ops),
            JSON.stringify([{"kind":"E","path":["title"],"lhs":"foo","rhs":"bar"}])
          )
        }).then(done).catch(done)
    })

    it('without changes: doesn`t add a patch', (done) => {
      Post.create({ title: 'baz' })
        .then((post) => post.save())
        .then((post) => post.patches.find({ ref: post.id }))
        .then((patches) => {
          assert.equal(patches.length, 1)
        }).then(done).catch(done)
    })
  })

  describe('removing a document', () => {
    it('removes all patches', (done) => {
      Post.findOne({ title: 'bar' })
        .then((post) => post.remove())
        .then((post) => post.patches.find({ ref: post.id }))
        .then((patches) => {
          assert.equal(patches.length, 0)
        }).then(done).catch(done)
    })
    it('doesn\'t remove patches when `removePatches` is false', (done) => {
      Comment.findOne({ text: 'wat' })
        .then((comment) => comment.remove())
        .then((comment) => comment.patches.find({ ref: comment.id }))
        .then((patches) => {
          assert.equal(patches.length, 1)
        }).then(done).catch(done)
    })
  })

  describe('rollback', () => {
    it('with unknown id is rejected', (done) => {
      Post.create({ title: 'version 1' })
        .then((post) => {
          return post.rollback(ObjectId())
            .then(() => { done() })
            .catch((err) => { assert(err instanceof RollbackError); done() })
        })
    })

    it('to latest patch is rejected', (done) => {
      Post.create({ title: 'version 1' })
        .then((post) => join(post, post.patches.findOne({ ref: post.id })))
        .then(([post, latestPatch]) => {
          return post.rollback(latestPatch.id)
            .then(() => { done() })
            .catch((err) => { assert(err instanceof RollbackError); done() })
        })
    })

    it('adds a new patch and updates the document', (done) => {
      Comment.create({ text: 'comm 1', user: ObjectId() })
        .then((c) => Comment.findOne({ _id: c.id }))
        .then((c) => c.set({ text: 'comm 2', user: ObjectId() }).save())
        .then((c) => Comment.findOne({ _id: c.id }))
        .then((c) => c.set({ text: 'comm 3', user: ObjectId() }).save())
        .then((c) => Comment.findOne({ _id: c.id }))
        .then((c) => join(c, c.patches.find({ ref: c.id }).sort({_id: -1})))
        .then(([c, patches]) => c.rollback(patches[0].id, { user: ObjectId() }))
        .then((c) => {
          assert.equal(c.text, 'comm 2')
          return c.patches.find({ ref: c.id })
        })
        .then((patches) => assert.equal(patches.length, 4))
        .then(done).catch(done)
    })
  })

  describe('model and collection names', () => {
    const getCollectionNames = () => {
      return new Promise((resolve, reject) => {
        mongoose.connection.db.listCollections().toArray((err, collections) => {
          if (err) return reject(err)
          resolve(map(collections, 'name'))
        })
      })
    }

    it('pascalize for model and decamelize for collection', (done) => {
      join(
        () => assert(!!~mongoose.modelNames().indexOf('CommentPatches')),
        getCollectionNames().then((names) => {
          assert(!!~names.indexOf('comment_patches'))
        })
      ).then(() => done()).catch(done)
    })

    it('uses `transform` option when set', (done) => {
      join(
        () => assert(!!~mongoose.modelNames().indexOf('postpatches')),
        getCollectionNames().then((names) => {
          assert(!!~names.indexOf('post_history'))
        })
      ).then(() => done()).catch(done)
    })
  })

  describe('jsonpatch.compare', () => {
    let Organization
    let Person

    before(() => {
      Organization = mongoose.model('Organization', new mongoose.Schema({
        name: String
      }))

      const PersonSchema = new mongoose.Schema({
        name: String,
        organization: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Organization'
        }
      })

      PersonSchema.plugin(patchHistory, { mongoose, name: 'roomPatches' })
      Person = mongoose.model('Person', PersonSchema)
    })

    it('is able to handle ObjectId references correctly', (done) => {
      Organization.create({ text: 'Home' })
        .then((o1) => join(o1, Organization.create({ text: 'Work' })))
        .then(([ o1, o2 ]) => join(o1, o2, Person.create({ name: 'Bob', organization: o1._id })))
        .then(([ o1, o2, p ]) => join(o1, o2, p.set({ organization: o2._id }).save()))
        .then(([ o1, o2, p ]) => join(o1, o2, p.patches.find({ ref: p.id })))
        .then(([ o1, o2, patches ]) => {
          const pathFilter = (path) => (elem) => JSON.stringify(elem.path) === JSON.stringify(path)
          const firstOrganizationOperation = patches[0].ops.find(pathFilter(['organization']))
          const secondOrganizationOperation = patches[1].ops.find(pathFilter(['organization']))
          assert.equal(patches.length, 2)
          assert(firstOrganizationOperation)
          assert(secondOrganizationOperation)
          assert.equal(firstOrganizationOperation.rhs, o1._id.toString())
          assert.equal(secondOrganizationOperation.rhs, o2._id.toString())
        })
        .then(done).catch(done)
    })
  })
})
