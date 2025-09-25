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
    const isString = (x: any) => typeof x === "string";
    const typeChecker = {
      isbn: isString,
      title: isString,
      authors: (x: any) => Array.isArray(x) && x.every(isString) && x.length > 0,
      pages: (x: any) => typeof x === "number",
      year: (x: any) => typeof x === "number",
      publisher: isString,
      nCopies: (x: any) => typeof x === "number"
    }
    const semanticChecker = {
      pages: [(x: any) => Number.isInteger(x), (x: any) => x > 0],
      year: [(x: any) => Number.isInteger(x), (x: any) => x > 0],
      nCopies: [(x: any) => Number.isInteger(x), (x: any) => x > 0]
    }

    const validation = validate({nCopies: 1, ...req}, typeChecker, semanticChecker);
    
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
    const typeChecker = {
      search: (x: any) => typeof x === "string"
    };
    
    const semanticChecker = {
      search: [
        (x: string) => {
          const words = x.match(/\w+/g) ?? [];
          return words.some(word => word.length > 1);
        }
      ]
    };

    const validation = validate(req, typeChecker, semanticChecker);
    if (!validation.isOk) {
      return Errors.errResult(validation);
    }

    const searchText = req.search.toLowerCase();
    const words = (searchText.match(/\w+/g) ?? [])
      .filter((word: string) => word.length > 1);

    const matchingBooks = this.books.filter(book => {
      const bookText = [
        book.title,
        book.authors.join(' '),
        book.publisher
      ].join(' ').toLowerCase();

      return words.every((word: string) => bookText.includes(word));
    });

    matchingBooks.sort((a, b) => a.title.localeCompare(b.title));

    return Errors.okResult(matchingBooks);
  }

  /** Set up patron req.patronId to check out book req.isbn. 
   * 
   *  Errors:
   *    MISSING: patronId or isbn field is missing
   *    BAD_TYPE: patronId or isbn field is not a string.
   *    BAD_REQ error on business rule violation.
   */
  checkoutBook(req: Record<string, any>) : Errors.Result<void> {
    const typeChecker = {
      patronId: (x: any) => typeof x === "string",
      isbn: (x: any) => typeof x === "string"
    };
    const semanticChecker = {
      patronId: [(x: any) => x !== ""],   
      isbn: [
        // patron must be trying to check out a book that exists
        (x: any) => this.books.some((b: XBook) => x === b.isbn),
        
        // patron must be trying to check out a book that we have a copy of
        (x: any) => this.inStock(this.getBook(x)!),

        // patron must not be trying to check out a book they already have
        (x: any) => {
          const p = req.patronId;
          if (!this.checkout.has(p)) {
            return true;
          } else {
            const b = this.getBook(x)!;
            return !this.checkout.get(p)!.some((x: XBook) => this.areEqual(b, x))
          }
        }
      ]
    }
    const validation = validate(req, typeChecker, semanticChecker);
    if (validation.isOk) {
      const [patron, book] = [req.patronId, this.getBook(req.isbn)!];
      if (this.checkout.has(patron)) {
        this.checkout.get(patron)!.push(book);
      } else {
        this.checkout.set(patron, [book]);
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
    const typeChecker = {
      patronId: (x: any) => typeof x === "string",
      isbn: (x: any) => typeof x === "string"
    };
    const semanticChecker = {
      patronId: [(x: any) => x !== ""],
      isbn: [
        // patron must be trying to return a book that exists
        (x: any) => this.books.some((b: XBook) => b.isbn === x),

        // patron must be trying to return a book they have checked out
        (x: any) => this.checkout.get(req.patronId)?.some((b: XBook) => b.isbn === x) ?? false
      ]
    }

    const validation = validate(req, typeChecker, semanticChecker);
    if (validation.isOk) {
      const book = this.getBook(req.isbn)!;
      const checkoutList = this.checkout.get(req.patronId)!

      for (let i = 0; i < checkoutList.length; i++) {
        if (this.areEqual(checkoutList[i], book)) {
          checkoutList.splice(i, 1);
          break;
        }
      }

      return Errors.VOID_RESULT
    } else {
      return Errors.errResult(validation);
    }
  }
  
}


/********************** Domain Utility Functions ***********************/

function validate(
    req: Record<string, any>, 
    typeChecker: Record<string, (x: any) => boolean>, 
    semantics: Record<string, ((x: any) => boolean)[]>
  ): Errors.Result<Errors.Err> {
  // check presence and type
  for (let key in typeChecker) {
    if (req[key] === undefined) {
      return new Errors.ErrResult([Errors.error(key, {code: "MISSING", widget: key})]);
    } else if (!typeChecker[key](req[key])) {
      return new Errors.ErrResult([Errors.error(key, {code: "BAD_TYPE", widget: key})]);
    } 
  }

  for (let key in semantics) {
    for (let predicate of semantics[key]) {
      if (!predicate(req[key])) {
        return new Errors.ErrResult([Errors.error(key, {code: "BAD_REQ", widget: key})]);
      }
    }
  }

  return Errors.VOID_RESULT as Errors.Result<Errors.Err>
}


