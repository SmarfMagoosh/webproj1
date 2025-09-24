import { Errors } from 'cs544-js-utils';
import { title } from 'process';
import { receiveMessageOnPort } from 'worker_threads';

/** Note that errors are documented using the `code` option which must be
 *  returned (the `message` can be any suitable string which describes
 *  the error as specifically as possible).  Whenever possible, the
 *  error should also contain a `widget` option specifying the widget
 *  responsible for the error).
 *
 *  Note also that none of the function implementations should normally
 *  require a sequential scan over all books or patrons.
 */

/******************** Types for Validated Requests *********************/

/** used as an ID for a book */
type ISBN = string; 

/** used as an ID for a library patron */
type PatronId = string;

export type Book = {
  isbn: ISBN;
  title: string;
  authors: string[];
  pages: number;      //must be int > 0
  year: number;       //must be int > 0
  publisher: string;
  nCopies?: number;   //# of copies owned by library; not affected by borrows;
                      //must be int > 0; defaults to 1
};

export type XBook = Required<Book>;

type AddBookReq = Book;
type FindBooksReq = { search: string; };
type ReturnBookReq = { patronId: PatronId; isbn: ISBN; };
type CheckoutBookReq = { patronId: PatronId; isbn: ISBN; };

/************************ Main Implementation **************************/

export function makeLendingLibrary() {
  return new LendingLibrary();
}

export class LendingLibrary {
  private books: XBook[];
  private checkout: Map<string, XBook[]>;
  
  constructor() {
    this.books = [];
    this.checkout = new Map();
  }

  /********************** Validator Functions ***********************/

  // validator function for adding book request
  private validateAddRequest(req: Record<string, any>): Errors.Result<Errors.Err> {
    const num_fields = ["pages", "year", "nCopies"]
    const isString = (x: any) => typeof x === "string";
    const isInt = (x: any) => typeof x === "number";
    const isStringArr = (x: any) => Array.isArray(x) && x.every(isString) && x.length > 0;
    const bookTypeChecker = {
      isbn: isString,
      title: isString,
      authors: isStringArr,
      pages: isInt,
      year: isInt,
      publisher: isString,
      nCopies: (x: any) => x === undefined || isInt(x)
    }

    for (let key in bookTypeChecker) {
      const value = req[key];
      // make sure we are given a value (except nCopies which can be ommitted)
      if (value === undefined && key !== "nCopies") {
        return new Errors.ErrResult([Errors.error(key, {code: "MISSING", widget: key})]);
      }
      // run the type checking function to make sure each entry is well typed
      if (!bookTypeChecker[key as keyof typeof bookTypeChecker](value)) {
        return new Errors.ErrResult([Errors.error(key, {code: "BAD_TYPE", widget: key})]);
      }
      if (num_fields.includes(key)) {
        // when doing numerical checks, skip nCopies if its not present
        if (key === "nCopies" && value === undefined) {
          continue;
        // check that each present numerical entry is a positive integer
        } else if (!Number.isInteger(value) || value <= 0) {
          return new Errors.ErrResult([Errors.error(key, {code: "BAD_REQ", widget: key})]);
        }
      }
    }

    return Errors.VOID_RESULT as Errors.Result<Errors.Err>;
  }

    // validator function for checkout request
  private validateCheckoutRequest(req: Record<string, any>) : Errors.Result<Errors.Err> {
    // check presence
    if (req.patronId === undefined) {
      return new Errors.ErrResult([Errors.error("patronId", {code: "MISSING", widget: "patronId"})]);
    } else if (req.isbn === undefined) {
      return new Errors.ErrResult([Errors.error("isbn", {code: "MISSING", widget: "isbn"})]);
    }

    // check types
    if (typeof req.patronId !== "string") {
      return new Errors.ErrResult([Errors.error("patronId", {code: "BAD_TYPE", widget: "patronId"})]);
    } else if (typeof req.isbn !== "string") {
      return new Errors.ErrResult([Errors.error("isbn", {code: "BAD_TYPE", widget: "isbn"})]);
    }

    // check other constraints
    // patron must have a name
    if (req.patronId === "") {
      return new Errors.ErrResult([Errors.error("patronId", {code: "BAD_REQ", widget: "patronId"})]);
    }

    // patron must be trying to check out a book that exists
    if (this.books.every((a: XBook) => a.isbn != req.isbn)) {
      return new Errors.ErrResult([Errors.error("isbn", {code: "BAD_REQ", widget: "isbn"})])
    }

    const book: XBook = this.getBook(req.isbn)!;

    // patron must be trying to check out a book they don't already have
    if (this.checkout.get(req.patronId)?.some((b: XBook) => this.areEqual(book, b))) {
      return new Errors.ErrResult([Errors.error("isbn", {code: "BAD_REQ", widget: "isbn"})]);
    }

    // patron must be trying to check out a book that has a spare copy
    if (!this.inStock(book)) {
      return new Errors.ErrResult([Errors.error("isbn", {code: "BAD_REQ", widget: "isbn"})]);
    }

    return Errors.VOID_RESULT as Errors.Result<Errors.Err>;
  }

  /********************** Utility Methods ***********************/
  private getBook(isbn: string): XBook | null {
    for (let book of this.books) {
      if (book.isbn === isbn) {
        return book;
      }
    }
    return null;
  }

  private areEqual(b1: XBook, b2: XBook): boolean {
    return b1.isbn === b2.isbn;
  }

  private inStock(book: XBook): boolean {
    let count = 0;
    for (let v of this.checkout.values()) {
      if (v.some((b: XBook) => this.areEqual(b, book))) {
        count++;
      }
    }
    return book.nCopies > count;
  }

  /********************** Required ***********************/
  /** Add one-or-more copies of book represented by req to this library.
   *
   *  Errors:
   *    MISSING: one-or-more of the required fields is missing.
   *    BAD_TYPE: one-or-more fields have the incorrect type.
   *    BAD_REQ: other issues like nCopies not a positive integer 
   *             or book is already in library but data in obj is 
   *             inconsistent with the data already present.
   */
  addBook(req: Record<string, any>): Errors.Result<XBook> {
    const validation = this.validateCheckoutRequest(req);
    if (validation.isOk) {
      const bookToAdd: XBook = {
        isbn: req.isbn,
        title: req.title,
        authors: req.authors,
        pages: req.pages,
        year: req.year,
        publisher: req.publisher,
        nCopies: req.nCopies ?? 1
      };
      this.books.push(bookToAdd);
      return Errors.okResult(bookToAdd);    
    } else {
      return Errors.errResult(validation);
    }
  }

  /** Return all books matching (case-insensitive) all "words" in
   *  req.search, where a "word" is a max sequence of /\w/ of length > 1.
   *  Returned books should be sorted in ascending order by title.
   *
   *  Errors:
   *    MISSING: search field is missing
   *    BAD_TYPE: search field is not a string.
   *    BAD_REQ: no words in search
   */
  findBooks(req: Record<string, any>) : Errors.Result<XBook[]> {
    //TODO
    return Errors.errResult('TODO');  //placeholder
  }



  /** Set up patron req.patronId to check out book req.isbn. 
   * 
   *  Errors:
   *    MISSING: patronId or isbn field is missing
   *    BAD_TYPE: patronId or isbn field is not a string.
   *    BAD_REQ error on business rule violation.
   */
  checkoutBook(req: Record<string, any>) : Errors.Result<void> {
    const validation = this.validateAddRequest(req);
    if (validation.isOk) {
      const [patron, id] = [req.patronId, req.isbn];
      if (this.checkout.has(patron)) {
        this.checkout.get(patron)!.push(id);
      } else {
        this.checkout.set(patron, [id]);
      }
      return Errors.VOID_RESULT;
    } else {
      return Errors.errResult(validation);
    }
  }

  /** Set up patron req.patronId to returns book req.isbn.
   *  
   *  Errors:
   *    MISSING: patronId or isbn field is missing
   *    BAD_TYPE: patronId or isbn field is not a string.
   *    BAD_REQ error on business rule violation.
   */
  returnBook(req: Record<string, any>) : Errors.Result<void> {
    //TODO 
    return Errors.errResult('TODO');  //placeholder
  }
  
}


/********************** Domain Utility Functions ***********************/


//TODO: add domain-specific utility functions or classes.

/********************* General Utility Functions ***********************/

//TODO: add general utility functions or classes.

